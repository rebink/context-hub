import { ApiError, api } from "./api.js";

type Project = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  role: string;
  member_count: number;
  artifact_count: number;
};
type Options = {
  onUnauthorized(): void;
  onNavigate(view: "context" | "graphify" | "git" | "team" | "snapshots"): void;
};
type Git = {
  owner: string;
  repository_name: string;
  default_branch: string;
  last_known_commit_sha: string;
  status: string;
};
type Graph = { version: number; status: string; sourceCommitSha: string };
type Sync = { status: string; lastSeenAt: string };

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

function metric(label: string, value: string, note: string, onOpen?: () => void): HTMLElement {
  const card = element("article", "metric");
  card.append(
    element("p", undefined, label),
    element("strong", undefined, value),
    element("span", undefined, note),
  );
  if (onOpen) {
    const open = element("button", "metric-link", `Open ${label}`);
    open.type = "button";
    open.addEventListener("click", onOpen);
    card.append(open);
  }
  return card;
}

export function mountOverview(host: HTMLElement, project: Project, options: Options): () => void {
  const controller = new AbortController();
  const heading = element("div", "project-heading reveal");
  const titleRow = element("div", "title-row");
  titleRow.append(element("h1", undefined, project.name), element("span", "role", project.role));
  heading.append(
    element("p", "kicker", `${project.slug} / ${project.status.toLowerCase()}`),
    titleRow,
    element(
      "p",
      "project-description",
      project.description ?? "No project description has been added.",
    ),
  );
  const status = element("p", "activity-status", "Loading current Git, graph, and sync state...");
  status.setAttribute("role", "status");
  const grid = element("section", "metrics reveal");
  grid.setAttribute("aria-label", "Project status");
  grid.append(
    metric("Members", String(project.member_count), "Direct project access", () =>
      options.onNavigate("team"),
    ),
    metric("Artifacts", String(project.artifact_count), "Active published context records", () =>
      options.onNavigate("context"),
    ),
  );
  host.replaceChildren(heading, status, grid);
  void (async () => {
    const nullable = async <T>(path: string): Promise<T | null> => {
      try {
        return await api<T>(path, { signal: controller.signal });
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 404) return null;
        throw cause;
      }
    };
    try {
      const [gitReply, graphReply, syncReply] = await Promise.all([
        api<{ connection: Git | null }>(`/projects/${project.id}/git`, {
          signal: controller.signal,
        }),
        nullable<{ graph: Graph }>(`/projects/${project.id}/graphs/latest`),
        api<{ syncState: Sync | null }>(`/projects/${project.id}/sync-states/current`, {
          signal: controller.signal,
        }),
      ]);
      if (controller.signal.aborted) return;
      const git = gitReply.connection;
      const graph = graphReply?.graph ?? null;
      const sync = syncReply.syncState;
      grid.append(
        metric(
          "Git",
          git ? `${git.owner}/${git.repository_name}` : "Not connected",
          git
            ? `${git.status} / ${git.default_branch} / ${git.last_known_commit_sha}`
            : "No verified repository",
          () => options.onNavigate("git"),
        ),
        metric(
          "Graphify",
          graph ? `v${graph.version} / ${graph.status}` : "No READY graph",
          graph?.sourceCommitSha ?? "No current graph provenance",
          () => options.onNavigate("graphify"),
        ),
        metric(
          "Sync",
          sync?.status ?? "No client report",
          sync
            ? `Last seen ${new Date(sync.lastSeenAt).toLocaleString()}`
            : "No directly reported client state",
        ),
        metric(
          "Snapshots",
          "Immutable manifests",
          "Inspect exact Git, graph, and artifact provenance",
          () => options.onNavigate("snapshots"),
        ),
      );
      status.textContent = "Current project metadata loaded.";
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.status === 401) return options.onUnauthorized();
      status.textContent =
        "Some current project status could not be loaded. No placeholder values are shown.";
    }
  })();
  return () => controller.abort();
}
