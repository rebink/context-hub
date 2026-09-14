import {
  isProjectAuditAction,
  PROJECT_AUDIT_ACTIONS,
  type ProjectAuditAction,
} from "../../../packages/project-audit-contract.js";
import { activityLabel, safeMetadataEntries } from "./activity.js";
import { ApiError, api } from "./api.js";

type Options = {
  onUnauthorized(): void;
  onOpenProject?(projectId: string): void;
  onProjectConfiguration?(project: AuthorizedProjectConfiguration): void;
};
type GlobalEvent = {
  id: string;
  project: { id: string; name: string; slug: string; status: string };
  actor: { kind: string; id: string };
  action: ProjectAuditAction;
  target: { type: string; id: string };
  outcome: "SUCCEEDED" | "DENIED" | "FAILED";
  metadata: Record<string, unknown>;
  occurredAt: string;
};
type GlobalActivityPage = {
  events: GlobalEvent[];
  nextCursor: string | null;
  window: { from: string; to: string };
  projectStatusPolicy: string;
};
export type AuthorizedProjectConfiguration = {
  id: string;
  name: string;
  slug: string;
  status: string;
  settingsRevision: number;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  git: null | {
    provider: string;
    repository: { canonicalUrl: string; owner: string; name: string };
    defaultBranch: string;
    currentCommitSha: string;
    status: string;
    verifiedAt: string;
  };
  graph: null | { version: number; status: string; sourceCommitSha: string };
  sync: null | { status: string; lastSeenAt: string };
};

type SettingsReply = {
  account: {
    id: string;
    provider: string;
    providerUserId: string;
    username: string;
    displayName: string | null;
    createdAt: string;
    lastLoginAt: string;
  };
  session: { createdAt: string; expiresAt: string };
  projects: AuthorizedProjectConfiguration[];
  truncated: boolean;
  readOnly: true;
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function detailList(rows: Array<[string, string]>): HTMLDListElement {
  const list = element("dl", "management-details");
  for (const [label, value] of rows) {
    const row = element("div", "management-detail");
    row.append(element("dt", undefined, label), element("dd", undefined, value));
    list.append(row);
  }
  return list;
}

function eventCard(event: GlobalEvent, openProject?: (projectId: string) => void): HTMLElement {
  const card = element("article", `activity-event activity-event--${event.outcome.toLowerCase()}`);
  const heading = element("div", "activity-event__heading");
  heading.append(
    element("h3", undefined, activityLabel(event.action)),
    element("span", "activity-outcome", event.outcome),
  );
  const project = element(
    "button",
    "management-project-link",
    `${event.project.name} / ${event.project.status}`,
  );
  project.type = "button";
  project.addEventListener("click", () => openProject?.(event.project.id));
  card.append(
    heading,
    project,
    detailList([
      ["Actor", `${event.actor.kind} / ${event.actor.id}`],
      ["Target", `${event.target.type} / ${event.target.id}`],
      ["Time", new Date(event.occurredAt).toLocaleString()],
    ]),
  );
  const metadata = safeMetadataEntries(event.metadata);
  if (metadata.length) {
    const details = element("details", "activity-metadata");
    details.append(
      element("summary", undefined, "Event metadata"),
      detailList(
        metadata.map(([key, value]) => [
          activityLabel(key.replace(/([a-z])([A-Z])/g, "$1_$2")),
          value,
        ]),
      ),
    );
    card.append(details);
  }
  return card;
}

export function mountGlobalActivity(host: HTMLElement, options: Options): () => void {
  const controller = new AbortController();
  let cursor: string | null = null;
  let loading = false;
  host.innerHTML = `
    <section class="activity-shell management-shell reveal" aria-labelledby="global-activity-title">
      <div class="management-heading"><p class="kicker">Direct memberships / bounded</p><h1 id="global-activity-title">Activity</h1><p>A 30-day aggregate across projects you can access now. Active and archived projects are included unless filtered.</p></div>
      <form class="activity-filters" data-global-activity-filters>
        <label>Action<select name="action"><option value="">All actions</option></select></label>
        <label>Project status<select name="projectStatus"><option value="">Active + archived</option><option>ACTIVE</option><option>ARCHIVED</option></select></label>
        <button type="submit" class="primary-action">Apply filters</button>
      </form>
      <p class="activity-status" data-management-status role="status"></p>
      <div class="activity-list" data-management-list></div>
      <button type="button" class="workspace-action activity-more" data-management-more hidden>Load older events</button>
    </section>`;
  const form = host.querySelector<HTMLFormElement>("[data-global-activity-filters]");
  const actionSelect = form?.elements.namedItem("action") as HTMLSelectElement | null;
  const status = host.querySelector<HTMLElement>("[data-management-status]");
  const list = host.querySelector<HTMLElement>("[data-management-list]");
  const more = host.querySelector<HTMLButtonElement>("[data-management-more]");
  for (const action of PROJECT_AUDIT_ACTIONS)
    actionSelect?.append(new Option(activityLabel(action), action));

  async function load(append: boolean): Promise<void> {
    if (!form || !status || !list || !more || loading) return;
    loading = true;
    form
      .querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button,select")
      .forEach((control) => {
        control.disabled = true;
      });
    status.textContent = append
      ? "Loading older authorized activity..."
      : "Loading authorized activity...";
    const data = new FormData(form);
    const query = new URLSearchParams({ limit: "25" });
    for (const key of ["action", "projectStatus"] as const) {
      const value = String(data.get(key) ?? "");
      if (value) query.set(key, value);
    }
    if (append && cursor) query.set("cursor", cursor);
    try {
      const page = await api<GlobalActivityPage>(`/activity?${query}`, {
        signal: controller.signal,
      });
      if (!page.events.every((event) => isProjectAuditAction(event.action)))
        throw new Error("Invalid activity action");
      if (!append) list.replaceChildren();
      for (const event of page.events) list.append(eventCard(event, options.onOpenProject));
      cursor = page.nextCursor;
      more.hidden = cursor === null;
      status.textContent = list.childElementCount
        ? `${list.childElementCount} authorized event${list.childElementCount === 1 ? "" : "s"} shown.`
        : "No activity was recorded for these filters in the last 30 days.";
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) return options.onUnauthorized();
      status.textContent = "Authorized activity could not be loaded. No partial results are shown.";
    } finally {
      loading = false;
      form
        .querySelectorAll<HTMLButtonElement | HTMLSelectElement>("button,select")
        .forEach((control) => {
          control.disabled = false;
        });
    }
  }
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    cursor = null;
    void load(false);
  });
  more?.addEventListener("click", () => void load(true));
  void load(false);
  return () => controller.abort();
}

export function mountGlobalSettings(host: HTMLElement, options: Options): () => void {
  const controller = new AbortController();
  host.innerHTML = `
    <section class="management-shell reveal" aria-labelledby="global-settings-title">
      <div class="management-heading"><p class="kicker">Account + authorized configuration</p><h1 id="global-settings-title">Settings</h1><p>Read-only account, session, and project connection facts. Project changes stay inside each project's Settings view.</p></div>
      <p class="activity-status" data-management-status role="status">Loading account and configuration...</p>
      <div data-management-body></div>
    </section>`;
  const status = host.querySelector<HTMLElement>("[data-management-status]");
  const body = host.querySelector<HTMLElement>("[data-management-body]");
  void (async () => {
    try {
      const reply = await api<SettingsReply>("/settings", { signal: controller.signal });
      if (!status || !body || controller.signal.aborted) return;
      body.replaceChildren();
      const account = element("section", "management-panel");
      account.append(
        element("h2", undefined, "Current account"),
        detailList([
          ["Provider", reply.account.provider],
          ["Username", reply.account.username],
          ["Display name", reply.account.displayName ?? "Not set"],
          ["Last login", new Date(reply.account.lastLoginAt).toLocaleString()],
          ["Session expires", new Date(reply.session.expiresAt).toLocaleString()],
        ]),
      );
      const projects = element("section", "management-panel");
      projects.append(element("h2", undefined, "Authorized projects"));
      if (!reply.projects.length)
        projects.append(element("p", "management-empty", "No directly authorized projects."));
      for (const project of reply.projects) {
        options.onProjectConfiguration?.(project);
        const card = element("article", "configuration-card");
        const heading = element("div", "configuration-heading");
        heading.append(
          element("h3", undefined, project.name),
          element("span", "role", project.role),
        );
        const open = element("button", "management-project-link", "Open project settings");
        open.type = "button";
        open.addEventListener("click", () => options.onOpenProject?.(project.id));
        card.append(
          heading,
          open,
          detailList([
            [
              "Project",
              `${project.slug} / ${project.status} / revision ${project.settingsRevision}`,
            ],
            [
              "Git",
              project.git
                ? `${project.git.provider} / ${project.git.repository.owner}/${project.git.repository.name} / ${project.git.status}`
                : "Not connected",
            ],
            ["Branch", project.git?.defaultBranch ?? "Unavailable"],
            ["Current commit", project.git?.currentCommitSha ?? "Unavailable"],
            [
              "Graph",
              project.graph
                ? `v${project.graph.version} / ${project.graph.status} / ${project.graph.sourceCommitSha}`
                : "No graph",
            ],
            [
              "Latest sync",
              project.sync
                ? `${project.sync.status} / ${new Date(project.sync.lastSeenAt).toLocaleString()}`
                : "No client report",
            ],
          ]),
        );
        projects.append(card);
      }
      body.append(account, projects);
      status.textContent = reply.truncated
        ? "Showing the first 100 authorized projects."
        : `${reply.projects.length} authorized project${reply.projects.length === 1 ? "" : "s"}.`;
    } catch (cause) {
      if (controller.signal.aborted || !status) return;
      if (cause instanceof ApiError && cause.status === 401) return options.onUnauthorized();
      status.textContent =
        "Account and configuration could not be loaded. No partial overview is shown.";
    }
  })();
  return () => controller.abort();
}
