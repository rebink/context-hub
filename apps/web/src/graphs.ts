import { ApiError, api } from "./api.js";
import {
  directedResultRows,
  firstMissingGraphQueryField,
  type GraphNode,
  GraphOperationCoordinator,
  type GraphQueryOperation,
  type GraphQueryResult,
  type GraphVersion,
  graphCapabilities,
  graphGeneratorMetadata,
  graphResultAnnouncement,
  isQueryableGraph,
  normalizeGraphQuery,
  type ProjectRole,
  selectGraphState,
  shouldRestoreGraphFocus,
} from "./graph-helpers.js";

export type GraphProject = { id: string; role: ProjectRole };
type Hooks = { onUnauthorized: () => void };

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

function dateTime(value: string | null): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function detail(label: string, value: string, code = false): HTMLDivElement {
  const item = element("div", "graph-detail");
  const output = element("dd");
  output.append(code ? element("code", undefined, value) : document.createTextNode(value));
  item.append(element("dt", undefined, label), output);
  return item;
}

function statusCopy(graph: GraphVersion): string {
  if (graph.status === "QUEUED")
    return "Awaiting CI publication infrastructure. The build is reserved, but Phase 10 dispatch is not available.";
  if (graph.status === "BUILDING")
    return "A CI publisher has claimed this attempt and is building the immutable graph.";
  if (graph.status === "FAILED")
    return `Build failed with stable category ${graph.failureCategory ?? "UNKNOWN"}. The last READY graph, if present, remains current.`;
  if (graph.status === "SUPERSEDED")
    return "Historical immutable graph. A newer READY version is current.";
  return "Published, checksum-backed, and available for bounded explorer queries.";
}

function requestError(error: unknown, operation: "load" | "build" | "query"): string {
  if (!(error instanceof ApiError))
    return "The request failed. Check the connection and try again.";
  if (error.code === "STORAGE_INTEGRITY_ERROR")
    return "Graph storage verification failed. No unverified results are shown.";
  if (error.code === "GIT_NOT_CONNECTED")
    return "Connect and verify a repository before requesting generation.";
  if (error.status === 403) return "Your current project role does not permit this action.";
  if (error.status === 404)
    return operation === "query"
      ? "That graph version is no longer queryable."
      : "This project is no longer available.";
  if (error.status === 400)
    return "The server rejected the bounded query. Review the fields and try again.";
  return operation === "load"
    ? "Graph metadata or storage status could not be loaded. Try again."
    : operation === "build"
      ? "The generation request could not be reserved. Try again."
      : "The graph query could not be completed. Try again.";
}

export function mountGraphs(
  container: HTMLElement,
  project: GraphProject,
  hooks: Hooks,
): () => void {
  let mounted = true;
  const operations = new GraphOperationCoordinator();
  let graphs: GraphVersion[] = [];
  let newestAttempt: GraphVersion | null = null;
  let currentReady: GraphVersion | null = null;
  let selected: GraphVersion | null = null;
  let queryPending = false;
  let buildPending = false;
  const capability = graphCapabilities(project.role);

  container.replaceChildren();
  const shell = element("section", "graphs-view reveal");
  const live = element("p", "graph-live");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("role", "status");
  const body = element("div", "graph-body");
  shell.append(live, body);
  container.append(shell);
  renderLoading();
  void load();

  function handleAuth(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) hooks.onUnauthorized();
  }

  async function latest(signal: AbortSignal): Promise<GraphVersion | null> {
    try {
      return (
        await api<{ graph: GraphVersion }>(`/projects/${project.id}/graphs/latest`, { signal })
      ).graph;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async function load(focusKey?: string): Promise<void> {
    const request = operations.begin("load");
    operations.abort("query");
    queryPending = false;
    body.setAttribute("aria-busy", "true");
    live.classList.remove("graph-live--error");
    live.setAttribute("aria-live", "polite");
    live.textContent = "Loading graph attempts and current READY state...";
    if (!graphs.length) renderLoading();
    try {
      const [history, ready] = await Promise.all([
        api<{ graphs: GraphVersion[]; truncated: boolean }>(`/projects/${project.id}/graphs`, {
          signal: request.signal,
        }),
        latest(request.signal),
      ]);
      if (!mounted || !operations.isCurrent("load", request.token)) return;
      const state = selectGraphState(history.graphs, ready);
      graphs = state.graphs;
      newestAttempt = state.newestAttempt;
      currentReady = state.currentReady;
      selected = selected
        ? (graphs.find((graph) => graph.version === selected?.version && isQueryableGraph(graph)) ??
          state.selected)
        : state.selected;
      render();
      live.textContent = history.truncated
        ? "Graph status loaded. Version history is bounded to the newest 50 attempts."
        : "Graph status loaded.";
      if (focusKey)
        queueMicrotask(() => {
          const control = body.querySelector<HTMLElement>(`[data-focus-key="${focusKey}"]`);
          if (shouldRestoreGraphFocus(control)) control.focus();
        });
    } catch (error) {
      if (request.signal.aborted || !mounted || !operations.isCurrent("load", request.token))
        return;
      handleAuth(error);
      renderLoadError(error);
    } finally {
      if (operations.finish("load", request.token)) body.removeAttribute("aria-busy");
    }
  }

  function renderLoading(): void {
    body.replaceChildren();
    const header = element("div", "graph-header graph-skeleton");
    header.append(element("div", "skeleton-line"), element("div", "skeleton-title"));
    const blocks = element("div", "graph-loading-grid");
    for (let index = 0; index < 6; index += 1) blocks.append(element("span", "skeleton-block"));
    body.append(header, blocks, element("p", "detail-loading", "Loading graph metadata..."));
  }

  function renderLoadError(error: unknown): void {
    body.replaceChildren();
    const panel = element("section", "graph-error");
    panel.append(
      element("p", "kicker", "Graphify / API or storage error"),
      element("h1", undefined, "Status unavailable"),
      element("p", undefined, requestError(error, "load")),
    );
    const retry = action("Retry graph status", "primary-action", () => void load("load-retry"));
    retry.dataset.focusKey = "load-retry";
    panel.append(retry);
    body.append(panel);
    live.classList.add("graph-live--error");
    live.setAttribute("aria-live", "assertive");
    live.textContent = "Graph status could not be loaded.";
    queueMicrotask(() => retry.focus());
  }

  function action(label: string, className: string, handler: () => void): HTMLButtonElement {
    const control = element("button", className, label);
    control.type = "button";
    control.addEventListener("click", handler);
    return control;
  }

  function render(): void {
    body.replaceChildren();
    const header = element("header", "graph-header");
    const heading = element("div");
    heading.append(
      element("p", "kicker", "Derived context / immutable"),
      element("h1", undefined, "Graphify"),
    );
    const actions = element("div", "graph-header-actions");
    actions.append(element("p", "read-only-note", capability.label));
    const refresh = action("Refresh status", "secondary-action", () => void load("refresh"));
    refresh.dataset.focusKey = "refresh";
    actions.append(refresh);
    if (capability.canBuild) {
      const buildLabel = newestAttempt?.status === "FAILED" ? "Retry generation" : "Generate";
      const generate = action(buildLabel, "primary-action", () => void build());
      generate.dataset.focusKey = "build";
      generate.disabled =
        buildPending || newestAttempt?.status === "QUEUED" || newestAttempt?.status === "BUILDING";
      actions.append(generate);
    }
    header.append(heading, actions);
    body.append(header);

    if (!newestAttempt) {
      const empty = element("section", "graph-empty");
      empty.append(
        element("p", "kicker", "No graph versions"),
        element("h2", undefined, "No graph has been reserved."),
        element(
          "p",
          undefined,
          capability.canBuild
            ? "Generate reserves an immutable version for the verified repository commit. Publication awaits Phase 10 CI infrastructure."
            : "A project administrator can reserve generation after connecting a verified repository.",
        ),
      );
      body.append(empty);
      return;
    }

    body.append(renderAttemptSummary());
    if (selected)
      body.append(renderProvenance(selected), renderHistory(), renderExplorer(selected));
    else {
      body.append(renderHistory());
      const waiting = element("section", "graph-empty");
      waiting.append(
        element("p", "kicker", "Explorer unavailable"),
        element("h2", undefined, "No READY graph yet."),
        element(
          "p",
          undefined,
          "Queued, building, and failed attempts remain visible, but only READY or SUPERSEDED payloads can be queried.",
        ),
      );
      body.append(waiting);
    }
  }

  function renderAttemptSummary(): HTMLElement {
    const region = element("section", "graph-attempts");
    const newest = newestAttempt as GraphVersion;
    const newestPanel = element(
      "article",
      `graph-attempt graph-status--${newest.status.toLowerCase()}`,
    );
    newestPanel.append(
      element("p", "kicker", "Newest attempt"),
      element("h2", undefined, `v${newest.version} / ${newest.status}`),
      element("p", undefined, statusCopy(newest)),
      element("span", "graph-attempt-time", `Updated ${dateTime(newest.updatedAt)}`),
    );
    const readyPanel = element("article", "graph-attempt");
    readyPanel.append(
      element("p", "kicker", "Current READY"),
      element(
        "h2",
        undefined,
        currentReady ? `v${currentReady.version} / READY` : "None published",
      ),
      element(
        "p",
        undefined,
        currentReady
          ? "This is the newest successfully published graph, independent of newer in-flight or failed attempts."
          : "A failed or pending attempt never becomes current.",
      ),
    );
    region.append(newestPanel, readyPanel);
    return region;
  }

  function renderProvenance(graph: GraphVersion): HTMLElement {
    const section = element("section", "graph-provenance");
    section.append(
      element("h2", "section-title", `Selected graph / v${graph.version} ${graph.status}`),
    );
    const metadata = element("dl", "graph-detail-grid");
    const generation = graphGeneratorMetadata(graph);
    metadata.append(
      detail("Version", `v${graph.version}`),
      detail("Source commit", graph.sourceCommitSha, true),
      detail("Graphify", graph.graphifyVersion),
      detail("Adapter", graph.adapterVersion),
      detail("Profile", graph.profile),
      detail("Format", `v${graph.formatVersion}`),
      detail("Nodes", graph.nodeCount?.toLocaleString() ?? "Not published"),
      detail("Links", graph.linkCount?.toLocaleString() ?? "Not published"),
      detail("Hyperedges", graph.hyperedgeCount?.toLocaleString() ?? "Not published"),
      detail("Checksum", graph.checksum ?? "Not published", true),
      detail("Generator", generation.generator),
      detail("Generated by", generation.generatedBy),
      detail("Generated", dateTime(graph.generatedAt)),
      detail("Queued", dateTime(graph.queuedAt)),
      detail("Build started", dateTime(graph.buildStartedAt)),
      detail("Failed", dateTime(graph.failedAt)),
      detail("Failure category", graph.failureCategory ?? "None"),
      detail(
        "Repository",
        `${graph.repository.provider}:${graph.repository.owner}/${graph.repository.name}`,
      ),
      detail("Provider repository ID", graph.repository.providerRepositoryId, true),
      detail("Canonical repository", graph.repository.canonicalUrl, true),
      detail("Local sync", "Unavailable - local sync is not implemented"),
    );
    section.append(metadata);
    return section;
  }

  function renderHistory(): HTMLElement {
    const section = element("section", "graph-history");
    section.append(element("h2", "section-title", "Version history"));
    const list = element("div", "graph-history-list");
    for (const graph of graphs) {
      const queryable = isQueryableGraph(graph);
      const row = queryable
        ? action(
            "",
            `graph-history-row${selected?.version === graph.version ? " graph-history-row--active" : ""}`,
            () => {
              operations.abort("query");
              queryPending = false;
              selected = graph;
              render();
              live.textContent = `Selected graph version ${graph.version}.`;
              queueMicrotask(() => {
                const control = body.querySelector<HTMLElement>(
                  `[data-version="${graph.version}"]`,
                );
                if (shouldRestoreGraphFocus(control)) control.focus();
              });
            },
          )
        : element("div", "graph-history-row graph-history-row--static");
      row.dataset.version = String(graph.version);
      if (queryable)
        row.setAttribute("aria-current", selected?.version === graph.version ? "true" : "false");
      row.append(
        element("strong", undefined, `v${graph.version}`),
        element("span", `graph-status graph-status--${graph.status.toLowerCase()}`, graph.status),
        element("span", undefined, graph.failureCategory ?? `attempt ${graph.attempt}`),
        element("time", undefined, dateTime(graph.updatedAt)),
      );
      list.append(row);
    }
    section.append(list);
    return section;
  }

  function renderExplorer(graph: GraphVersion): HTMLElement {
    const section = element("section", "graph-explorer");
    const heading = element("div", "explorer-heading");
    heading.append(
      element("div", undefined, undefined),
      element(
        "p",
        "explorer-context",
        `v${graph.version} / ${graph.sourceCommitSha} / ${graph.checksum ?? "checksum unavailable"}`,
      ),
    );
    heading.firstElementChild?.append(
      element("p", "kicker", "Bounded operations / no full graph"),
      element("h2", "section-title", "Focused explorer"),
    );
    const columns = element("div", "explorer-columns");
    const form = createQueryForm(graph);
    const results = element("section", "explorer-results");
    results.setAttribute("aria-label", "Graph query results");
    results.append(
      element("h3", undefined, "Results"),
      element(
        "p",
        "explorer-placeholder",
        "Run one bounded operation to inspect source-backed graph evidence.",
      ),
    );
    columns.append(form, results);
    section.append(heading, columns);
    return section;
  }

  function createQueryForm(graph: GraphVersion): HTMLFormElement {
    const form = element("form", "explorer-form");
    const operation = element("select");
    operation.id = "graph-operation";
    operation.name = "operation";
    for (const [value, label] of [
      ["search", "Search nodes"],
      ["node", "Inspect node"],
      ["neighbors", "Neighbors"],
      ["callers", "Callers (incoming)"],
      ["callees", "Callees (outgoing)"],
      ["path", "Shortest directed path"],
      ["sources", "Sources"],
    ] as const) {
      const option = element("option", undefined, label);
      option.value = value;
      operation.append(option);
    }
    appendField(form, "Operation", operation, "Choose one bounded server-side query.");
    const query = element("input");
    query.name = "query";
    query.maxLength = 128;
    appendField(
      form,
      "Search text",
      query,
      "Required for search; matches node ID, label, or source file.",
    );
    const nodeId = element("input");
    nodeId.name = "nodeId";
    nodeId.maxLength = 512;
    appendField(
      form,
      "Node ID",
      nodeId,
      "Required for inspection, neighbors, callers, and callees; optional for sources.",
    );
    const source = element("input");
    source.name = "source";
    source.maxLength = 512;
    appendField(form, "Path source node ID", source, "Required for shortest directed path.");
    const target = element("input");
    target.name = "target";
    target.maxLength = 512;
    appendField(form, "Path target node ID", target, "Required for shortest directed path.");
    const limits = element("div", "explorer-limit-row");
    const limit = element("input");
    limit.name = "limit";
    limit.type = "number";
    limit.min = "1";
    limit.max = "25";
    limit.value = "25";
    const depth = element("input");
    depth.name = "maxDepth";
    depth.type = "number";
    depth.min = "1";
    depth.max = "8";
    depth.value = "8";
    appendField(limits, "Result limit", limit, "1-25 results.");
    appendField(limits, "Maximum path depth", depth, "1-8 directed links.");
    form.append(limits);
    const error = element("p", "field-error");
    error.setAttribute("aria-live", "polite");
    error.dataset.queryError = "";
    const submit = element("button", "primary-action", "Run query");
    submit.type = "submit";
    submit.dataset.focusKey = "query";
    form.append(error, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void runQuery(graph, form, operation.value as GraphQueryOperation);
    });
    const cancelPendingQuery = () => {
      if (!queryPending) return;
      operations.abort("query");
      queryPending = false;
      submit.disabled = false;
      error.textContent = "";
      const results = body.querySelector<HTMLElement>(".explorer-results");
      results?.replaceChildren(
        element("h3", undefined, "Results"),
        element("p", "explorer-placeholder", "Query changed. Run the updated bounded operation."),
      );
      live.textContent = "Pending graph query canceled because its inputs changed.";
    };
    form.addEventListener("input", cancelPendingQuery);
    form.addEventListener("change", cancelPendingQuery);
    return form;
  }

  function appendField(
    parent: HTMLElement,
    labelText: string,
    control: HTMLInputElement | HTMLSelectElement,
    helperText: string,
  ): void {
    const wrapper = element("div", "explorer-field");
    const id = `graph-${control.name}`;
    control.id = id;
    const label = element("label", undefined, labelText);
    label.htmlFor = id;
    const helper = element("p", "field-helper", helperText);
    helper.id = `${id}-help`;
    control.setAttribute("aria-describedby", helper.id);
    wrapper.append(label, control, helper);
    parent.append(wrapper);
  }

  async function runQuery(
    graph: GraphVersion,
    form: HTMLFormElement,
    operation: GraphQueryOperation,
  ): Promise<void> {
    // A second submit replaces an in-flight request, including for the same version.
    if (queryPending) {
      operations.abort("query");
      queryPending = false;
    }
    const data = new FormData(form);
    const payload = normalizeGraphQuery({
      operation,
      query: data.get("query"),
      nodeId: data.get("nodeId"),
      source: data.get("source"),
      target: data.get("target"),
      limit: data.get("limit"),
      maxDepth: data.get("maxDepth"),
    });
    const missing = firstMissingGraphQueryField(operation, payload);
    const error = form.querySelector<HTMLElement>("[data-query-error]");
    if (missing) {
      if (error) error.textContent = "Complete the fields required for the selected operation.";
      form.querySelector<HTMLInputElement>(`[name="${missing}"]`)?.focus();
      return;
    }
    queryPending = true;
    const request = operations.begin("query");
    const submit = form.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.disabled = true;
    if (error) error.textContent = "";
    const results = body.querySelector<HTMLElement>(".explorer-results");
    results?.replaceChildren(
      element("h3", undefined, "Results"),
      element("p", "explorer-placeholder", "Running bounded query..."),
    );
    live.classList.remove("graph-live--error");
    live.setAttribute("aria-live", "polite");
    live.textContent = `Running ${operation} query against graph version ${graph.version}...`;
    try {
      const reply = await api<{ graph: GraphVersion; result: GraphQueryResult }>(
        `/projects/${project.id}/graphs/${graph.version}/query`,
        {
          method: "POST",
          body: JSON.stringify(payload),
          signal: request.signal,
        },
      );
      if (
        !mounted ||
        !operations.isCurrent("query", request.token) ||
        selected?.version !== graph.version
      )
        return;
      renderResults(results, reply.graph, reply.result);
      live.textContent = graphResultAnnouncement(reply.result);
    } catch (cause) {
      if (request.signal.aborted || !mounted || !operations.isCurrent("query", request.token))
        return;
      handleAuth(cause);
      if (error) error.textContent = requestError(cause, "query");
      live.classList.add("graph-live--error");
      live.textContent = "Graph query failed. No unverified results are shown.";
    } finally {
      if (operations.finish("query", request.token)) {
        queryPending = false;
        if (mounted && shouldRestoreGraphFocus(submit)) {
          submit.disabled = false;
          submit.focus();
        }
      }
    }
  }

  function renderResults(
    target: HTMLElement | null,
    graph: GraphVersion,
    result: GraphQueryResult,
  ): void {
    if (!target) return;
    target.replaceChildren(element("h3", undefined, "Results"));
    const context = element(
      "p",
      "result-context",
      `Graph v${graph.version} / commit ${graph.sourceCommitSha} / checksum ${graph.checksum ?? "unavailable"}`,
    );
    target.append(context);
    if (result.truncated)
      target.append(
        element("p", "truncation-note", "Truncated - refine the query or inspect a specific node."),
      );
    if (result.node) target.append(nodeResult(result.node));
    for (const node of result.nodes ?? []) target.append(nodeResult(node));
    for (const row of directedResultRows(result)) {
      const item = element("article", "result-row");
      item.append(
        element("strong", undefined, row.heading),
        element("span", undefined, row.detail),
        element("code", undefined, row.source),
      );
      target.append(item);
    }
    for (const source of result.sources ?? []) {
      const item = element("article", "result-row");
      item.append(
        element("strong", undefined, source.file),
        element("code", undefined, source.location),
      );
      target.append(item);
    }
    if (result.path) {
      const path = element("article", "result-path");
      path.append(element("strong", undefined, "Directed shortest path"));
      for (const node of result.path.nodes)
        path.append(element("span", undefined, node.label ?? node.id));
      target.append(path);
      for (const row of directedResultRows({ ...result, links: result.path.links })) {
        const item = element("article", "result-row");
        item.append(
          element("strong", undefined, row.heading),
          element("span", undefined, row.detail),
          element("code", undefined, row.source),
        );
        target.append(item);
      }
    }
    const hasResults = Boolean(
      result.node ||
        result.nodes?.length ||
        result.links?.length ||
        result.sources?.length ||
        result.path,
    );
    if (!hasResults)
      target.append(element("p", "explorer-placeholder", "No matching graph evidence was found."));
  }

  function nodeResult(node: GraphNode): HTMLElement {
    const item = element("article", "result-row");
    item.append(
      element("strong", undefined, node.label ?? node.id),
      element("span", undefined, [node.type, node.id].filter(Boolean).join(" / ")),
      element(
        "code",
        undefined,
        [node.sourceFile, node.sourceLocation].filter(Boolean).join(":") ||
          "Source location unavailable",
      ),
    );
    return item;
  }

  async function build(): Promise<void> {
    if (!capability.canBuild || buildPending) return;
    buildPending = true;
    const request = operations.begin("build");
    const button = body.querySelector<HTMLButtonElement>("[data-focus-key=build]");
    if (button) button.disabled = true;
    live.classList.remove("graph-live--error");
    live.setAttribute("aria-live", "polite");
    live.textContent =
      newestAttempt?.status === "FAILED"
        ? "Retrying graph generation..."
        : "Reserving graph generation...";
    try {
      const response = await api<{ dispatch?: string }>(`/projects/${project.id}/graphs/build`, {
        method: "POST",
        body: JSON.stringify({}),
        signal: request.signal,
      });
      if (!mounted || !operations.isCurrent("build", request.token)) return;
      operations.finish("build", request.token);
      buildPending = false;
      await load("refresh");
      live.textContent =
        response.dispatch === "ORPHAN_RECONCILIATION_PENDING"
          ? "A prior unpublished object is in its safety grace period. Retry after status refresh."
          : "Generation reserved. Awaiting Phase 10 CI publication infrastructure.";
    } catch (error) {
      if (request.signal.aborted || !mounted || !operations.isCurrent("build", request.token))
        return;
      operations.finish("build", request.token);
      buildPending = false;
      handleAuth(error);
      if (button) {
        button.disabled = false;
        button.focus();
      }
      live.classList.add("graph-live--error");
      live.setAttribute("aria-live", "assertive");
      live.textContent = requestError(error, "build");
    }
  }

  return () => {
    mounted = false;
    queryPending = false;
    buildPending = false;
    operations.abortAll();
  };
}
