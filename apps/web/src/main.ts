import "./styles.css";
import { ApiError, api, loginUrl } from "./api.js";
import { mountArtifacts } from "./artifacts.js";
import { mountGit } from "./git.js";
import { callbackFreeUrl, matchGitCallbackProject, parseGitCallback } from "./git-helpers.js";
import { mountGraphs } from "./graphs.js";

type User = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
};

type Workspace = {
  id: string;
  name: string;
  slug: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
};

type Project = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  member_count: number;
  artifact_count: number;
};
const root = document.querySelector<HTMLElement>("#app");
let user: User | null = null;
let workspaces: Workspace[] = [];
let projects: Project[] = [];
let activeWorkspaceId = "";
let activeProjectId = localStorage.getItem("context-hub-project") ?? "";
let activeProjectView: "overview" | "artifacts" | "graphify" = "overview";
let unmountProjectView: (() => void) | null = null;
let refreshGeneration = 0;
let refreshController = new AbortController();
let gitCallback = parseGitCallback(window.location.search);

function setText(selector: string, value: string): void {
  const target = root?.querySelector<HTMLElement>(selector);
  if (target) target.textContent = value;
}

function button(label: string, className = "project-link"): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = className;
  item.textContent = label;
  return item;
}

function validImage(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function renderLoggedOut(message = "Sign in to open your project context."): void {
  if (!root) return;
  unmountProjectView?.();
  unmountProjectView = null;
  root.innerHTML = `
    <main class="auth-shell">
      <header class="masthead">
        <a class="wordmark" href="/" aria-label="Context Hub home">CH<span>/</span>02</a>
        <p>Context control plane</p>
      </header>
      <section class="auth-hero" aria-labelledby="auth-title">
        <p class="kicker">Project intelligence / bounded</p>
        <h1 id="auth-title">Keep the signal.<br>Lose the noise.</h1>
        <div class="auth-action">
          <p data-auth-message></p>
          <a class="primary-action" data-login href="#">Continue with GitHub</a>
        </div>
      </section>
      <footer class="footer"><span>Git / D1 / R2</span><span>Source-backed by design</span></footer>
    </main>`;
  setText("[data-auth-message]", message);
  const login = root.querySelector<HTMLAnchorElement>("[data-login]");
  if (login) login.href = loginUrl();
}

function projectForWorkspace(): Project | null {
  const available = projects.filter((project) => project.workspace_id === activeWorkspaceId);
  const selected =
    available.find((project) => project.id === activeProjectId) ?? available[0] ?? null;
  if (selected && selected.id !== activeProjectId) {
    activeProjectId = selected.id;
    localStorage.setItem("context-hub-project", selected.id);
  }
  return selected;
}

function renderProject(project: Project): void {
  const content = root?.querySelector<HTMLElement>("[data-content]");
  if (!content) return;
  unmountProjectView?.();
  unmountProjectView = null;
  content.innerHTML = `
    <nav class="project-tabs" aria-label="Project views">
      <button type="button" data-project-tab="overview">Overview</button>
      <button type="button" data-project-tab="artifacts">Artifacts</button>
      <button type="button" data-project-tab="graphify">Graphify</button>
    </nav>
    <div data-project-view></div>`;
  content.querySelectorAll<HTMLButtonElement>("[data-project-tab]").forEach((tab) => {
    const view = tab.dataset.projectTab as "overview" | "artifacts" | "graphify";
    const active = view === activeProjectView;
    tab.classList.toggle("project-tab--active", active);
    tab.setAttribute("aria-current", active ? "page" : "false");
    tab.addEventListener("click", () => {
      activeProjectView = view;
      renderProject(project);
    });
  });
  const view = content.querySelector<HTMLElement>("[data-project-view]");
  if (!view) return;
  if (activeProjectView === "artifacts") {
    unmountProjectView = mountArtifacts(view, project, {
      onUnauthorized: () => renderLoggedOut("Your session expired. Sign in again."),
      onCountChange: (count) => {
        project.artifact_count = count;
      },
    });
    return;
  }
  if (activeProjectView === "graphify") {
    unmountProjectView = mountGraphs(view, project, {
      onUnauthorized: () => renderLoggedOut("Your session expired. Sign in again."),
    });
    return;
  }
  view.innerHTML = `
    <div class="project-heading reveal">
      <p class="kicker" data-project-slug></p>
      <div class="title-row">
        <h1 data-project-name></h1>
        <span class="role" data-project-role></span>
      </div>
      <p class="project-description" data-project-description></p>
    </div>
    <section class="metrics reveal" aria-label="Project status">
      <article class="metric metric--primary">
        <p>Members</p><strong data-members></strong><span>Direct project access</span>
      </article>
      <article class="metric">
        <p>Artifacts</p><strong data-artifacts></strong><span>Published context records</span>
      </article>
      <article class="metric metric--wide" data-git-region></article>
      <article class="metric">
        <p>Graphify</p><strong>Project graph</strong><span>Open the Graphify tab for live status, provenance, and bounded queries</span>
      </article>
      <article class="metric">
        <p>Sync</p><strong>Not configured</strong><span>No local client</span>
      </article>
    </section>`;
  setText("[data-project-slug]", `${project.slug} / ${project.status.toLowerCase()}`);
  setText("[data-project-name]", project.name);
  setText("[data-project-role]", project.role);
  setText(
    "[data-project-description]",
    project.description ?? "No project description has been added.",
  );
  setText("[data-members]", String(project.member_count));
  setText("[data-artifacts]", String(project.artifact_count));
  const gitRegion = view.querySelector<HTMLElement>("[data-git-region]");
  if (gitRegion) {
    const callback = gitCallback;
    gitCallback = null;
    unmountProjectView = mountGit(
      gitRegion,
      project,
      { onUnauthorized: () => renderLoggedOut("Your session expired. Sign in again.") },
      callback,
    );
  }
}

function renderEmpty(): void {
  if (!root) return;
  const content = root.querySelector<HTMLElement>("[data-content]");
  if (!content) return;
  const workspace = workspaces.find((item) => item.id === activeWorkspaceId);
  const hasWorkspace = Boolean(workspace);
  const canCreateProject = workspace?.role === "ADMIN";
  const title = !hasWorkspace
    ? "Create a workspace."
    : canCreateProject
      ? "Create the first project."
      : "No project access.";
  const description = !hasWorkspace
    ? "A workspace holds projects and their direct memberships."
    : canCreateProject
      ? "Projects keep repository context and access boundaries separate."
      : "Ask a project administrator to grant direct access.";
  const action = !hasWorkspace
    ? '<button class="primary-action" type="button" data-empty-action>New workspace</button>'
    : canCreateProject
      ? '<button class="primary-action" type="button" data-empty-action>New project</button>'
      : "";
  content.innerHTML = `
    <section class="empty-state reveal" aria-labelledby="empty-title">
      <p class="kicker">${hasWorkspace ? "Workspace ready" : "Start here"}</p>
      <h1 id="empty-title">${title}</h1>
      <p>${description}</p>
      ${action}
    </section>`;
  root.querySelector<HTMLButtonElement>("[data-empty-action]")?.addEventListener("click", () => {
    const dialog = root.querySelector<HTMLDialogElement>(
      hasWorkspace ? "[data-project-dialog]" : "[data-workspace-dialog]",
    );
    dialog?.showModal();
  });
}

function populateNavigation(): void {
  const workspaceSelect = root?.querySelector<HTMLSelectElement>("[data-workspace-select]");
  const projectList = root?.querySelector<HTMLElement>("[data-project-list]");
  if (!workspaceSelect || !projectList) return;

  for (const workspace of workspaces) {
    const option = document.createElement("option");
    option.value = workspace.id;
    option.textContent = workspace.name;
    option.selected = workspace.id === activeWorkspaceId;
    workspaceSelect.append(option);
  }

  for (const project of projects.filter((item) => item.workspace_id === activeWorkspaceId)) {
    const item = button(project.name);
    item.classList.toggle("project-link--active", project.id === activeProjectId);
    item.setAttribute("aria-current", project.id === activeProjectId ? "page" : "false");
    item.addEventListener("click", () => {
      activeProjectId = project.id;
      localStorage.setItem("context-hub-project", project.id);
      renderDashboard();
    });
    projectList.append(item);
  }

  workspaceSelect.addEventListener("change", () => {
    activeWorkspaceId = workspaceSelect.value;
    activeProjectId = "";
    renderDashboard();
  });
}

function formError(form: HTMLFormElement, message: string): void {
  const target = form.querySelector<HTMLElement>("[data-form-error]");
  if (target) target.textContent = message;
}

async function refreshData(): Promise<void> {
  const generation = ++refreshGeneration;
  refreshController.abort();
  refreshController = new AbortController();
  const [workspaceReply, projectReply] = await Promise.all([
    api<{ workspaces: Workspace[] }>("/workspaces", { signal: refreshController.signal }),
    api<{ projects: Project[] }>("/projects", { signal: refreshController.signal }),
  ]);
  if (generation !== refreshGeneration) return;
  workspaces = workspaceReply.workspaces;
  projects = projectReply.projects;
  if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
    activeWorkspaceId =
      projects.find((project) => project.id === activeProjectId)?.workspace_id ??
      workspaces[0]?.id ??
      "";
  }
  if (gitCallback) {
    const matchedCallback = matchGitCallbackProject(
      gitCallback,
      projects.map((project) => project.id),
    );
    history.replaceState(history.state, "", callbackFreeUrl(new URL(window.location.href)));
    gitCallback = matchedCallback;
    if (matchedCallback?.projectId) {
      const callbackProject = projects.find((project) => project.id === matchedCallback.projectId);
      if (callbackProject) {
        activeProjectId = callbackProject.id;
        activeWorkspaceId = callbackProject.workspace_id;
        localStorage.setItem("context-hub-project", callbackProject.id);
        activeProjectView = "overview";
      }
    }
  }
}

function bindForms(): void {
  root?.querySelectorAll<HTMLButtonElement>("[data-close-dialog]").forEach((control) => {
    control.addEventListener("click", () => control.closest("dialog")?.close());
  });

  const workspaceForm = root?.querySelector<HTMLFormElement>("[data-workspace-form]");
  workspaceForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = workspaceForm.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.disabled = true;
    formError(workspaceForm, "");
    const data = new FormData(workspaceForm);
    try {
      const reply = await api<{ workspace: Workspace }>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: data.get("name"), slug: data.get("slug") }),
      });
      activeWorkspaceId = reply.workspace.id;
      await refreshData();
      renderDashboard();
    } catch (cause) {
      formError(
        workspaceForm,
        cause instanceof ApiError && cause.status === 409
          ? "That workspace slug is already used."
          : "Workspace creation failed.",
      );
      if (submit) submit.disabled = false;
    }
  });

  const projectForm = root?.querySelector<HTMLFormElement>("[data-project-form]");
  projectForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = projectForm.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.disabled = true;
    formError(projectForm, "");
    const data = new FormData(projectForm);
    try {
      const reply = await api<{ project: Project }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: activeWorkspaceId,
          name: data.get("name"),
          slug: data.get("slug"),
          description: data.get("description"),
        }),
      });
      activeProjectId = reply.project.id;
      localStorage.setItem("context-hub-project", reply.project.id);
      await refreshData();
      renderDashboard();
    } catch (cause) {
      formError(
        projectForm,
        cause instanceof ApiError && cause.status === 409
          ? "That project slug is already used here."
          : "Project creation failed.",
      );
      if (submit) submit.disabled = false;
    }
  });
}

function renderDashboard(): void {
  if (!root || !user) return;
  unmountProjectView?.();
  unmountProjectView = null;
  root.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <a class="wordmark" href="/" aria-label="Context Hub home">CH<span>/</span>02</a>
        <div class="identity">
          <span class="avatar" data-avatar-fallback aria-hidden="true"></span>
          <img class="avatar" data-avatar alt="" hidden>
          <span data-username></span>
          <button class="text-action" type="button" data-logout>Sign out</button>
        </div>
      </header>
      <aside class="sidebar" aria-label="Project navigation">
        <label for="workspace">Workspace</label>
        <select id="workspace" data-workspace-select></select>
        <div class="nav-heading"><span>Projects</span><button type="button" data-new-project>New</button></div>
        <nav class="project-list" data-project-list></nav>
        <button class="workspace-action" type="button" data-new-workspace>New workspace</button>
      </aside>
      <section class="content" data-content></section>
      <footer class="footer app-footer"><span>Context Hub / Project view</span><span>Evidence over volume</span></footer>

      <dialog data-workspace-dialog aria-labelledby="workspace-dialog-title">
        <form class="dialog-form" data-workspace-form>
          <div class="dialog-heading"><h2 id="workspace-dialog-title">New workspace</h2><button type="button" data-close-dialog aria-label="Close">Close</button></div>
          <label for="workspace-name">Name</label><input id="workspace-name" name="name" maxlength="100" required>
          <label for="workspace-slug">Slug</label><input id="workspace-slug" name="slug" maxlength="63" pattern="[a-z0-9]+(-[a-z0-9]+)*" required>
          <p class="form-error" data-form-error aria-live="polite"></p>
          <button class="primary-action" type="submit">Create workspace</button>
        </form>
      </dialog>

      <dialog data-project-dialog aria-labelledby="project-dialog-title">
        <form class="dialog-form" data-project-form>
          <div class="dialog-heading"><h2 id="project-dialog-title">New project</h2><button type="button" data-close-dialog aria-label="Close">Close</button></div>
          <label for="project-name">Name</label><input id="project-name" name="name" maxlength="100" required>
          <label for="project-slug">Slug</label><input id="project-slug" name="slug" maxlength="63" pattern="[a-z0-9]+(-[a-z0-9]+)*" required>
          <label for="project-description">Description</label><textarea id="project-description" name="description" maxlength="500" rows="4"></textarea>
          <p class="form-error" data-form-error aria-live="polite"></p>
          <button class="primary-action" type="submit">Create project</button>
        </form>
      </dialog>
    </main>`;

  setText("[data-username]", user.display_name ?? user.username);
  setText("[data-avatar-fallback]", user.username.slice(0, 1).toUpperCase());
  const avatar = root.querySelector<HTMLImageElement>("[data-avatar]");
  const avatarUrl = validImage(user.avatar_url);
  if (avatar && avatarUrl) {
    avatar.src = avatarUrl;
    avatar.hidden = false;
    root.querySelector<HTMLElement>("[data-avatar-fallback]")?.setAttribute("hidden", "");
  }

  const activeProject = projectForWorkspace();
  populateNavigation();
  if (activeProject) renderProject(activeProject);
  else renderEmpty();

  const newProject = root.querySelector<HTMLButtonElement>("[data-new-project]");
  const canCreateProject =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.role === "ADMIN";
  if (newProject) newProject.hidden = !canCreateProject;
  newProject?.addEventListener("click", () => {
    root.querySelector<HTMLDialogElement>("[data-project-dialog]")?.showModal();
  });
  root.querySelector<HTMLButtonElement>("[data-new-workspace]")?.addEventListener("click", () => {
    root.querySelector<HTMLDialogElement>("[data-workspace-dialog]")?.showModal();
  });
  root.querySelector<HTMLButtonElement>("[data-logout]")?.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST" });
    localStorage.removeItem("context-hub-project");
    renderLoggedOut("Session closed.");
  });
  bindForms();
}

async function bootstrap(): Promise<void> {
  try {
    const session = await api<{ user: User }>("/auth/session");
    user = session.user;
    await refreshData();
    renderDashboard();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) renderLoggedOut();
    else renderLoggedOut("The control plane is unavailable. Try again shortly.");
  }
}

void bootstrap();
