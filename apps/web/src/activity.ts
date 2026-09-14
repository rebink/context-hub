import {
  isProjectAuditAction,
  PROJECT_AUDIT_ACTIONS,
  type ProjectAuditAction,
} from "../../../packages/project-audit-contract.js";
import { ApiError, api } from "./api.js";

export type ActivityEvent = {
  id: string;
  projectId: string;
  actor: { kind: "HUMAN" | "MACHINE" | "MCP" | "SYSTEM"; id: string };
  action: ProjectAuditAction;
  target: { type: string; id: string };
  outcome: "SUCCEEDED" | "DENIED" | "FAILED";
  metadata: Record<string, unknown>;
  occurredAt: string;
};

type ActivityPage = {
  events: ActivityEvent[];
  nextCursor: string | null;
  window: { from: string; to: string };
  projectStatus: string;
};

type Project = { id: string; name: string; status: string };
type Options = { onUnauthorized(): void };

export function activityLabel(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function safeMetadataEntries(metadata: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(metadata).flatMap(([key, value]) => {
    if (value === null) return [[key, "None"]];
    if (["string", "number", "boolean"].includes(typeof value)) return [[key, String(value)]];
    return [];
  });
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function eventCard(event: ActivityEvent): HTMLElement {
  const article = element(
    "article",
    `activity-event activity-event--${event.outcome.toLowerCase()}`,
  );
  const heading = element("div", "activity-event__heading");
  const title = element("h3");
  title.textContent = activityLabel(event.action);
  const outcome = element("span", "activity-outcome");
  outcome.textContent = event.outcome;
  heading.append(title, outcome);
  const provenance = element("dl", "activity-provenance");
  const rows: Array<[string, string]> = [
    ["Project", event.projectId],
    ["Actor", `${event.actor.kind} / ${event.actor.id}`],
    ["Target", `${event.target.type} / ${event.target.id}`],
    ["Time", new Date(event.occurredAt).toLocaleString()],
  ];
  for (const [key, value] of rows) {
    const term = element("dt");
    term.textContent = key;
    const detail = element("dd");
    detail.textContent = value;
    provenance.append(term, detail);
  }
  article.append(heading, provenance);
  const entries = safeMetadataEntries(event.metadata);
  if (entries.length > 0) {
    const details = element("details", "activity-metadata");
    const summary = element("summary");
    summary.textContent = "Event metadata";
    const list = element("dl");
    for (const [key, value] of entries) {
      const term = element("dt");
      term.textContent = activityLabel(key.replace(/([a-z])([A-Z])/g, "$1_$2"));
      const detail = element("dd");
      detail.textContent = value;
      list.append(term, detail);
    }
    details.append(summary, list);
    article.append(details);
  }
  return article;
}

export function mountActivity(host: HTMLElement, project: Project, options: Options): () => void {
  let controller = new AbortController();
  let generation = 0;
  let mounted = true;
  let cursor: string | null = null;
  host.innerHTML = `
    <section class="activity-shell reveal" aria-labelledby="activity-title">
      <div class="activity-heading">
        <div><p class="kicker">Immutable project history</p><h1 id="activity-title">Activity</h1>
        <p>Exact actors, targets, outcomes, and D1-recorded times. History remains readable when a project is archived.</p></div>
      </div>
      <form class="activity-filters" data-activity-filters>
        <label>Action<select name="action"><option value="">All actions</option></select></label>
        <label>Actor kind<select name="actorKind"><option value="">All actors</option><option>HUMAN</option><option>MACHINE</option><option>MCP</option><option>SYSTEM</option></select></label>
        <label>Actor ID<input name="actorId" maxlength="255" autocomplete="off" placeholder="Required with kind"></label>
        <button type="submit" class="primary-action">Apply filters</button>
      </form>
      <p class="activity-status" data-activity-status role="status"></p>
      <div class="activity-list" data-activity-list></div>
      <button type="button" class="workspace-action activity-more" data-activity-more hidden>Load older events</button>
    </section>`;
  const form = host.querySelector<HTMLFormElement>("[data-activity-filters]");
  const actionSelect = form?.elements.namedItem("action") as HTMLSelectElement | null;
  const list = host.querySelector<HTMLElement>("[data-activity-list]");
  const status = host.querySelector<HTMLElement>("[data-activity-status]");
  const more = host.querySelector<HTMLButtonElement>("[data-activity-more]");
  for (const action of PROJECT_AUDIT_ACTIONS) {
    const option = document.createElement("option");
    option.value = action;
    option.textContent = activityLabel(action);
    actionSelect?.append(option);
  }

  async function load(append: boolean): Promise<void> {
    if (!form || !list || !status || !more || !mounted) return;
    const requestGeneration = ++generation;
    controller.abort();
    controller = new AbortController();
    const requestController = controller;
    form
      .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
        "button,input,select",
      )
      .forEach((control) => {
        control.disabled = true;
      });
    more.disabled = true;
    status.textContent = append ? "Loading older activity..." : "Loading project activity...";
    const data = new FormData(form);
    const action = String(data.get("action") ?? "");
    const actorKind = String(data.get("actorKind") ?? "");
    const actorId = String(data.get("actorId") ?? "").trim();
    if ((actorKind === "") !== (actorId === "")) {
      status.textContent = "Choose both an actor kind and actor ID, or leave both empty.";
      form
        .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
          "button,input,select",
        )
        .forEach((control) => {
          control.disabled = false;
        });
      more.disabled = false;
      return;
    }
    const query = new URLSearchParams({ limit: "25" });
    if (action) query.set("action", action);
    if (actorKind) {
      query.set("actorKind", actorKind);
      query.set("actorId", actorId);
    }
    if (append && cursor) query.set("cursor", cursor);
    try {
      const page = await api<ActivityPage>(`/projects/${project.id}/activity?${query}`, {
        signal: requestController.signal,
      });
      if (!mounted || requestGeneration !== generation) return;
      if (!page.events.every((event) => isProjectAuditAction(event.action))) {
        throw new Error("Invalid activity action");
      }
      if (!append) list.replaceChildren();
      for (const event of page.events) list.append(eventCard(event));
      cursor = page.nextCursor;
      more.hidden = cursor === null;
      status.textContent =
        list.childElementCount === 0
          ? "No activity was recorded in the last 30 days for these filters."
          : `${list.childElementCount} event${list.childElementCount === 1 ? "" : "s"} shown${page.projectStatus === "ARCHIVED" ? " / archived project" : ""}.`;
    } catch (cause) {
      if (requestController.signal.aborted || !mounted || requestGeneration !== generation) return;
      if (cause instanceof ApiError && cause.status === 401) {
        options.onUnauthorized();
        return;
      }
      status.textContent =
        cause instanceof ApiError && cause.status === 404
          ? "Project activity is unavailable."
          : "Activity could not be loaded. Try again.";
    } finally {
      if (mounted && requestGeneration === generation) {
        form
          .querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>(
            "button,input,select",
          )
          .forEach((control) => {
            control.disabled = false;
          });
        more.disabled = false;
      }
    }
  }
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    cursor = null;
    void load(false);
  });
  more?.addEventListener("click", () => void load(true));
  void load(false);
  return () => {
    mounted = false;
    ++generation;
    controller.abort();
  };
}
