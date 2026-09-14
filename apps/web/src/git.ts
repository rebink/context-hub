import { ApiError, api } from "./api.js";
import {
  canManageGit,
  type GitCallback,
  gitLoadAnnouncement,
  isCurrentGitRequest,
  validateRepositoryUrl,
} from "./git-helpers.js";

export type GitProject = {
  id: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
};

type GitConnection = {
  provider: string;
  canonical_url: string;
  owner: string;
  repository_name: string;
  default_branch: string;
  last_known_commit_sha: string;
  provider_repository_id: string;
  status: string;
  verified_at: string;
  created_at: string;
  updated_at: string;
};

type Hooks = {
  onUnauthorized: () => void;
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

function dateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? "Unknown"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function requestError(
  error: unknown,
  operation: "load" | "connect" | "refresh" | "disconnect",
): string {
  if (!(error instanceof ApiError)) return "The request failed. Try again.";
  if (error.status === 403) return "Your current project role does not permit this action.";
  if (error.code === "GIT_RATE_LIMITED" || error.status === 429) {
    return "GitHub is limiting requests. Wait a moment and try again.";
  }
  if (error.code === "GIT_STALE_OPERATION" || error.status === 409) {
    return "The connection changed before this action completed. Reload its current status.";
  }
  if (error.code === "GIT_ALREADY_CONNECTED") {
    return "This project already has a repository connection. Reload its current status.";
  }
  if (operation === "connect" && error.status === 400) {
    return "The server rejected this repository URL. Review it and try again.";
  }
  if (operation === "load" && error.status === 404) {
    return "This project is no longer available.";
  }
  return operation === "load"
    ? "Repository status could not be loaded. Try again."
    : `The repository could not be ${operation === "refresh" ? "refreshed" : operation === "disconnect" ? "disconnected" : "connected"}. Try again.`;
}

function safeInstallationUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function mountGit(
  container: HTMLElement,
  project: GitProject,
  hooks: Hooks,
  callback: GitCallback | null,
): () => void {
  let generation = 0;
  let controller = new AbortController();
  let currentProjectId = project.id;
  let connection: GitConnection | null = null;
  let pendingCallback = callback;
  const canMutate = canManageGit(project.role);

  container.replaceChildren();
  container.classList.add("git-region");
  const heading = element("div", "git-heading");
  heading.append(element("p", undefined, "Git status"));
  const live = element("p", "git-live");
  live.setAttribute("aria-live", "polite");
  const body = element("div", "git-body");
  heading.append(live);
  container.append(heading, body);

  const connectDialog = createConnectDialog();
  const disconnectDialog = createDisconnectDialog();
  container.append(connectDialog, disconnectDialog);
  void load();

  function action(label: string, className: string, handler: () => void): HTMLButtonElement {
    const control = element("button", className, label);
    control.type = "button";
    control.addEventListener("click", handler);
    return control;
  }

  function isCurrent(requestGeneration: number): boolean {
    return isCurrentGitRequest(requestGeneration, project.id, generation, currentProjectId);
  }

  async function load(): Promise<void> {
    const requestGeneration = ++generation;
    controller.abort();
    controller = new AbortController();
    applyLoadAnnouncement(gitLoadAnnouncement({ kind: "pending" }));
    container.setAttribute("aria-busy", "true");
    if (!connection) renderLoading();
    try {
      const reply = await api<{ connection: GitConnection | null }>(`/projects/${project.id}/git`, {
        signal: controller.signal,
      });
      if (!isCurrent(requestGeneration)) return;
      connection = reply.connection;
      if (connection) renderConnected();
      else renderEmpty();
      const announcement = gitLoadAnnouncement({
        kind: "success",
        callback: pendingCallback,
        connectionStatus: connection?.status ?? null,
      });
      pendingCallback = null;
      applyLoadAnnouncement(announcement);
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(requestGeneration)) return;
      pendingCallback = null;
      handleAuth(error);
      renderLoadError(error);
    } finally {
      if (isCurrent(requestGeneration)) container.removeAttribute("aria-busy");
    }
  }

  function applyLoadAnnouncement(announcement: ReturnType<typeof gitLoadAnnouncement>): void {
    live.classList.toggle("git-live--error", announcement.isError);
    live.setAttribute("aria-live", announcement.isError ? "assertive" : "polite");
    live.textContent = announcement.message;
  }

  function renderLoading(): void {
    body.replaceChildren(
      element("strong", "git-state", "Loading"),
      element("span", "git-summary", "Checking the project repository connection."),
    );
  }

  function renderEmpty(): HTMLElement | null {
    body.replaceChildren();
    body.append(
      element("strong", "git-state", "Not connected"),
      element(
        "span",
        "git-summary",
        canMutate
          ? "Connect one GitHub repository to establish source identity and commit status."
          : "A project administrator must connect the GitHub repository. Your access is read-only.",
      ),
    );
    if (canMutate) {
      const actions = element("div", "git-actions");
      const connect = action("Connect GitHub", "primary-action", openConnect);
      actions.append(connect);
      body.append(actions);
      return connect;
    }
    return body.querySelector(".git-state");
  }

  function renderConnected(): void {
    if (!connection) return;
    body.replaceChildren();
    const repository = `${connection.owner}/${connection.repository_name}`;
    const title = element("div", "git-title");
    title.append(element("strong", "git-repository", repository));
    const status = element("span", "git-status", connection.status);
    title.append(status);

    const details = element("dl", "git-details");
    details.append(
      detail("Default branch", connection.default_branch),
      shaDetail(connection.last_known_commit_sha),
      detail("Verified", dateTime(connection.verified_at)),
      detail("Updated", dateTime(connection.updated_at)),
    );
    body.append(title, details);
    if (canMutate) {
      const actions = element("div", "git-actions");
      actions.append(
        action("Refresh", "secondary-action", () => void refreshConnection()),
        action("Disconnect", "text-action", openDisconnect),
      );
      body.append(actions);
    } else {
      body.append(
        element("span", "git-summary", "Repository controls require project administrator access."),
      );
    }
  }

  function detail(label: string, value: string): HTMLDivElement {
    const item = element("div", "git-detail");
    item.append(element("dt", undefined, label), element("dd", undefined, value));
    return item;
  }

  function shaDetail(value: string): HTMLDivElement {
    const item = detail("Current commit", "");
    const output = item.querySelector("dd");
    if (output) {
      const code = element("code", undefined, value.slice(0, 8));
      code.title = value;
      code.setAttribute("aria-label", `Current commit ${value}`);
      output.append(code);
    }
    return item;
  }

  function renderLoadError(error: unknown): void {
    body.replaceChildren(
      element("strong", "git-state", "Status unavailable"),
      element("span", "git-summary", requestError(error, "load")),
      action("Retry", "secondary-action", () => void load()),
    );
    applyLoadAnnouncement(
      gitLoadAnnouncement({
        kind: "error",
        message: "Repository status could not be loaded.",
      }),
    );
  }

  async function refreshConnection(): Promise<void> {
    if (!connection) return;
    const requestGeneration = ++generation;
    const controls = body.querySelectorAll<HTMLButtonElement>("button");
    controls.forEach((control) => {
      control.disabled = true;
    });
    live.classList.remove("git-live--error");
    live.textContent = "Refreshing repository status...";
    try {
      const reply = await api<{
        changed: boolean;
        defaultBranch: string;
        lastKnownCommitSha: string;
        verifiedAt: string;
      }>(`/projects/${project.id}/git/sync`, { method: "POST" });
      if (!isCurrent(requestGeneration) || !connection) return;
      connection = {
        ...connection,
        default_branch: reply.defaultBranch,
        last_known_commit_sha: reply.lastKnownCommitSha,
        verified_at: reply.verifiedAt,
        updated_at: reply.verifiedAt,
        status: "VERIFIED",
      };
      renderConnected();
      live.textContent = reply.changed
        ? "Repository status refreshed with new source metadata."
        : "Repository status is already current.";
    } catch (error) {
      if (!isCurrent(requestGeneration)) return;
      handleAuth(error);
      renderConnected();
      live.textContent = requestError(error, "refresh");
      live.classList.add("git-live--error");
    }
  }

  function createConnectDialog(): HTMLDialogElement {
    const dialog = element("dialog", "git-dialog");
    dialog.setAttribute("aria-labelledby", "git-connect-title");
    const form = element("form", "dialog-form");
    const header = element("div", "dialog-heading");
    const title = element("h2", undefined, "Connect GitHub");
    title.id = "git-connect-title";
    header.append(
      title,
      action("Close", "text-action", () => dialog.close()),
    );
    const label = element("label", undefined, "Repository URL");
    label.htmlFor = "git-repository-url";
    const input = element("input");
    input.id = label.htmlFor;
    input.name = "repositoryUrl";
    input.type = "text";
    input.required = true;
    input.maxLength = 512;
    input.setAttribute("autocomplete", "url");
    input.spellcheck = false;
    input.setAttribute("aria-describedby", "git-repository-help git-repository-error");
    const helper = element(
      "p",
      "field-helper",
      "Use a GitHub HTTPS or SSH URL, for example https://github.com/owner/repository or git@github.com:owner/repository.git.",
    );
    helper.id = "git-repository-help";
    const error = element("p", "field-error");
    error.id = "git-repository-error";
    error.setAttribute("aria-live", "polite");
    const formError = element("p", "form-error");
    formError.setAttribute("aria-live", "polite");
    formError.dataset.formError = "";
    const submit = element("button", "primary-action", "Continue to GitHub");
    submit.type = "submit";
    form.append(header, label, input, helper, error, formError, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void submitConnect(form, input, error, formError);
    });
    dialog.addEventListener("cancel", (event) => {
      if (submit.disabled) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      error.textContent = "";
      formError.textContent = "";
      input.removeAttribute("aria-invalid");
      form.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
        control.disabled = false;
      });
    });
    dialog.append(form);
    return dialog;
  }

  function openConnect(): void {
    connectDialog.showModal();
    connectDialog.querySelector<HTMLInputElement>("input")?.focus();
  }

  async function submitConnect(
    form: HTMLFormElement,
    input: HTMLInputElement,
    fieldError: HTMLElement,
    formError: HTMLElement,
  ): Promise<void> {
    const repositoryUrl = String(new FormData(form).get("repositoryUrl") ?? "");
    const validationError = validateRepositoryUrl(repositoryUrl);
    fieldError.textContent = validationError ?? "";
    input.toggleAttribute("aria-invalid", Boolean(validationError));
    if (validationError) {
      input.focus();
      return;
    }
    form.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
      control.disabled = true;
    });
    formError.textContent = "Starting the secure GitHub App flow...";
    const requestGeneration = generation;
    try {
      const reply = await api<{ installationUrl: string }>(`/projects/${project.id}/git`, {
        method: "POST",
        body: JSON.stringify({ repositoryUrl }),
      });
      if (!isCurrent(requestGeneration)) return;
      const destination = safeInstallationUrl(reply.installationUrl);
      if (!destination) throw new ApiError(500, "INVALID_RESPONSE");
      window.location.assign(destination);
    } catch (error) {
      if (!isCurrent(requestGeneration)) return;
      handleAuth(error);
      formError.textContent = requestError(error, "connect");
      form.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
        control.disabled = false;
      });
    }
  }

  function createDisconnectDialog(): HTMLDialogElement {
    const dialog = element("dialog", "git-dialog");
    dialog.setAttribute("aria-labelledby", "git-disconnect-title");
    const form = element("form", "dialog-form");
    const header = element("div", "dialog-heading");
    const title = element("h2", undefined, "Disconnect repository");
    title.id = "git-disconnect-title";
    header.append(
      title,
      action("Close", "text-action", () => dialog.close()),
    );
    const warning = element("p", "dialog-copy");
    warning.dataset.disconnectWarning = "";
    const error = element("p", "form-error");
    error.setAttribute("aria-live", "polite");
    const actions = element("div", "dialog-actions");
    const cancel = action("Keep connected", "secondary-action", () => dialog.close());
    const confirm = element("button", "primary-action", "Disconnect");
    confirm.type = "submit";
    actions.append(cancel, confirm);
    form.append(header, warning, error, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void disconnect(error);
    });
    dialog.addEventListener("cancel", (event) => {
      if (confirm.disabled) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      error.textContent = "";
      form.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
        control.disabled = false;
      });
    });
    dialog.append(form);
    return dialog;
  }

  function openDisconnect(): void {
    if (!connection) return;
    const repository = `${connection.owner}/${connection.repository_name}`;
    const warning = disconnectDialog.querySelector<HTMLElement>("[data-disconnect-warning]");
    if (warning) {
      warning.textContent = `Disconnect ${repository}? Context Hub will remove this project's verified repository link.`;
    }
    disconnectDialog.showModal();
    disconnectDialog.querySelector<HTMLButtonElement>("[type=submit]")?.focus();
  }

  async function disconnect(error: HTMLElement): Promise<void> {
    if (!connection) return;
    const requestGeneration = ++generation;
    disconnectDialog.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
      control.disabled = true;
    });
    error.textContent = "Disconnecting repository...";
    try {
      await api(`/projects/${project.id}/git`, { method: "DELETE" });
      if (!isCurrent(requestGeneration)) return;
      connection = null;
      disconnectDialog.close();
      const focusTarget = renderEmpty();
      live.classList.remove("git-live--error");
      live.textContent = "Repository disconnected.";
      queueMicrotask(() => focusTarget?.focus());
    } catch (cause) {
      if (!isCurrent(requestGeneration)) return;
      handleAuth(cause);
      error.textContent = requestError(cause, "disconnect");
      disconnectDialog.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
        control.disabled = false;
      });
    }
  }

  function handleAuth(error: unknown): void {
    if (error instanceof ApiError && error.status === 401) hooks.onUnauthorized();
  }

  return () => {
    ++generation;
    currentProjectId = "";
    controller.abort();
    connectDialog.close();
    disconnectDialog.close();
  };
}
