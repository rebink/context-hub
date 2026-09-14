import "./styles.css";
import { mountActivity } from "./activity.js";
import { ApiError, api, loginUrl } from "./api.js";
import { mountArtifacts } from "./artifacts.js";
import { mountGit } from "./git.js";
import { callbackFreeUrl, matchGitCallbackProject, parseGitCallback } from "./git-helpers.js";
import { mountGraphs } from "./graphs.js";
import {
  type AuthorizedProjectConfiguration,
  mountGlobalActivity,
  mountGlobalSettings,
} from "./management.js";
import {
  ManagementCoordinator,
  resolveCurrentProject,
  restoreFocusAfterDialog,
} from "./management-coordinator.js";
import type { AppRoute, ProjectView } from "./navigation.js";
import { mountOverview } from "./overview.js";
import { mountProjectSettings } from "./project-settings.js";
import { mountSnapshots } from "./snapshots.js";
import { mountInvitationInbox, mountTeam } from "./team.js";

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
  settings_revision: number;
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
let unmountProjectView: (() => void) | null = null;
let refreshGeneration = 0;
let refreshController = new AbortController();
let projectRouteController = new AbortController();
let gitCallback = parseGitCallback(window.location.search);
const coordinator = new ManagementCoordinator(window.location.pathname, history, () => {
  user = null;
  workspaces = [];
  projects = [];
  activeWorkspaceId = "";
  activeProjectId = "";
  gitCallback = null;
  localStorage.removeItem("context-hub-project");
});

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
  coordinator.clearAuthentication();
  refreshController.abort();
  projectRouteController.abort();
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

function showDialog(dialog: HTMLDialogElement | null, opener: HTMLElement): void {
  if (!dialog) return;
  dialog.addEventListener(
    "close",
    () => {
      restoreFocusAfterDialog(opener);
    },
    { once: true },
  );
  dialog.showModal();
}

function focusCurrentView(): void {
  queueMicrotask(() => {
    const focusTarget =
      root?.querySelector<HTMLElement>("h1") ??
      root?.querySelector<HTMLElement>("[aria-current='page']");
    if (focusTarget) {
      if (focusTarget.tagName === "H1") focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
    }
  });
}

function navigate(route: AppRoute, replace = false): void {
  coordinator.navigate(route, replace);
  if (route.kind === "project") {
    activeProjectId = route.projectId;
    activeWorkspaceId =
      projects.find((project) => project.id === route.projectId)?.workspace_id ?? activeWorkspaceId;
    localStorage.setItem("context-hub-project", route.projectId);
  }
  renderDashboard();
  focusCurrentView();
}

function renderProject(project: Project, projectView: ProjectView): void {
  const content = root?.querySelector<HTMLElement>("[data-content]");
  if (!content) return;
  unmountProjectView?.();
  unmountProjectView = null;
  const tabs = document.createElement("nav");
  tabs.className = "project-tabs";
  tabs.setAttribute("aria-label", "Project navigation");
  const labels: Array<[ProjectView, string]> = [
    ["overview", "Overview"],
    ["context", "Context"],
    ["graphify", "Graphify"],
    ["git", "Git"],
    ["team", "Team"],
    ["snapshots", "Snapshots"],
    ["activity", "Activity"],
    ["settings", "Settings"],
  ];
  for (const [routeView, label] of labels) {
    const tab = button(label);
    const active = routeView === projectView;
    tab.classList.toggle("project-tab--active", active);
    if (active) tab.setAttribute("aria-current", "page");
    tab.addEventListener("click", () =>
      navigate({ kind: "project", projectId: project.id, view: routeView }),
    );
    tabs.append(tab);
  }
  const view = document.createElement("div");
  content.replaceChildren(tabs, view);
  const unauthorized = () => renderLoggedOut("Your session expired. Sign in again.");
  if (projectView === "context") {
    unmountProjectView = mountArtifacts(view, project, {
      onUnauthorized: unauthorized,
      onCountChange: (count) => {
        project.artifact_count = count;
      },
    });
  } else if (projectView === "graphify") {
    unmountProjectView = mountGraphs(view, project, { onUnauthorized: unauthorized });
  } else if (projectView === "git") {
    const shell = document.createElement("section");
    shell.className = "management-shell reveal";
    const heading = document.createElement("div");
    heading.className = "management-heading";
    const kicker = document.createElement("p");
    kicker.className = "kicker";
    kicker.textContent = "Source identity / verified";
    const title = document.createElement("h1");
    title.textContent = "Git";
    const copy = document.createElement("p");
    copy.textContent =
      "Repository, default branch, current commit, verification state, and role-aware connection controls.";
    heading.append(kicker, title, copy);
    const region = document.createElement("div");
    shell.append(heading, region);
    view.replaceChildren(shell);
    const callback = gitCallback;
    gitCallback = null;
    unmountProjectView = mountGit(region, project, { onUnauthorized: unauthorized }, callback);
  } else if (projectView === "team") {
    unmountProjectView = mountTeam(view, project, user?.id ?? "", {
      onUnauthorized: unauthorized,
      onCountChange: (count) => {
        project.member_count = count;
      },
    });
  } else if (projectView === "snapshots") {
    unmountProjectView = mountSnapshots(view, project, { onUnauthorized: unauthorized });
  } else if (projectView === "activity") {
    unmountProjectView = mountActivity(view, project, { onUnauthorized: unauthorized });
  } else if (projectView === "settings") {
    unmountProjectView = mountProjectSettings(view, project, {
      onUnauthorized: unauthorized,
      onUpdated: (updated) => {
        Object.assign(project, updated);
        const projectLink = root?.querySelector<HTMLButtonElement>(
          `[data-project-id="${project.id}"]`,
        );
        if (projectLink) projectLink.textContent = project.name;
      },
    });
  } else {
    unmountProjectView = mountOverview(view, project, {
      onUnauthorized: unauthorized,
      onNavigate: (next) => navigate({ kind: "project", projectId: project.id, view: next }),
    });
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
  const section = document.createElement("section");
  section.className = "empty-state reveal";
  section.setAttribute("aria-labelledby", "empty-title");
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = hasWorkspace ? "Workspace ready" : "Start here";
  const heading = document.createElement("h1");
  heading.id = "empty-title";
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description;
  section.append(kicker, heading, copy);
  if (!hasWorkspace || canCreateProject) {
    const action = button(!hasWorkspace ? "New workspace" : "New project", "primary-action");
    action.dataset.emptyAction = "";
    action.addEventListener("click", () => {
      const dialog = root.querySelector<HTMLDialogElement>(
        hasWorkspace ? "[data-project-dialog]" : "[data-workspace-dialog]",
      );
      showDialog(dialog, action);
    });
    section.append(action);
  }
  content.replaceChildren(section);
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
    item.dataset.projectId = project.id;
    const ariaCurrent = coordinator.projectAriaCurrent(project.id);
    item.classList.toggle("project-link--active", ariaCurrent === "page");
    if (ariaCurrent) item.setAttribute("aria-current", ariaCurrent);
    item.addEventListener("click", () => {
      navigate({ kind: "project", projectId: project.id, view: "overview" });
    });
    projectList.append(item);
  }

  workspaceSelect.addEventListener("change", () => {
    activeWorkspaceId = workspaceSelect.value;
    activeProjectId = "";
    navigate({ kind: "global", view: "projects" });
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
  let workspaceReply: { workspaces: Workspace[] };
  let projectReply: { projects: Project[] };
  try {
    [workspaceReply, projectReply] = await Promise.all([
      api<{ workspaces: Workspace[] }>("/workspaces", { signal: refreshController.signal }),
      api<{ projects: Project[] }>("/projects", { signal: refreshController.signal }),
    ]);
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) {
      renderLoggedOut("Your session expired. Sign in again.");
    }
    throw cause;
  }
  if (generation !== refreshGeneration) return;
  workspaces = workspaceReply.workspaces;
  projects = projectReply.projects;
  if (coordinator.route.kind === "project") activeProjectId = coordinator.route.projectId;
  if (!workspaces.some((workspace) => workspace.id === activeWorkspaceId)) {
    activeWorkspaceId =
      projects.find((project) => project.id === activeProjectId)?.workspace_id ??
      workspaces[0]?.id ??
      "";
  }
  const routedProjectId = coordinator.route.kind === "project" ? coordinator.route.projectId : null;
  if (routedProjectId && !projects.some((project) => project.id === routedProjectId)) {
    coordinator.navigate({ kind: "global", view: "projects" }, true);
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
        coordinator.navigate({ kind: "project", projectId: callbackProject.id, view: "git" }, true);
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
    const viewGeneration = coordinator.generation;
    const submit = workspaceForm.querySelector<HTMLButtonElement>("[type=submit]");
    if (submit) submit.disabled = true;
    formError(workspaceForm, "");
    const data = new FormData(workspaceForm);
    try {
      const reply = await api<{ workspace: Workspace }>("/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: data.get("name"), slug: data.get("slug") }),
      });
      if (!coordinator.isCurrent(viewGeneration)) return;
      activeWorkspaceId = reply.workspace.id;
      await refreshData();
      if (!coordinator.isCurrent(viewGeneration)) return;
      renderDashboard();
      focusCurrentView();
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
    const viewGeneration = coordinator.generation;
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
      if (!coordinator.isCurrent(viewGeneration)) return;
      activeProjectId = reply.project.id;
      localStorage.setItem("context-hub-project", reply.project.id);
      coordinator.navigate(
        { kind: "project", projectId: reply.project.id, view: "overview" },
        false,
      );
      await refreshData();
      renderDashboard();
      focusCurrentView();
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

function applyAuthorizedProjectConfiguration(project: AuthorizedProjectConfiguration): void {
  const current = projects.find((item) => item.id === project.id);
  if (!current) return;
  current.name = project.name;
  current.slug = project.slug;
  current.status = project.status;
  current.settings_revision = project.settingsRevision;
  current.role = project.role;
}

function renderProjectIndex(content: HTMLElement): void {
  const available = projects.filter((project) => project.workspace_id === activeWorkspaceId);
  if (!available.length) {
    renderEmpty();
    return;
  }
  const section = document.createElement("section");
  section.className = "management-shell reveal";
  const heading = document.createElement("div");
  heading.className = "management-heading";
  const kicker = document.createElement("p");
  kicker.className = "kicker";
  kicker.textContent = "Direct access / current";
  const title = document.createElement("h1");
  title.textContent = "Projects";
  title.tabIndex = -1;
  const copy = document.createElement("p");
  copy.textContent = "Choose a project to open its source-backed management surfaces.";
  heading.append(kicker, title, copy);
  const list = document.createElement("div");
  list.className = "project-catalog";
  for (const project of available) {
    const open = button(project.name, "project-card");
    const description = document.createElement("span");
    description.textContent = project.description ?? "No project description.";
    const facts = document.createElement("span");
    facts.textContent = `${project.status} / ${project.role} / ${project.member_count} members / ${project.artifact_count} active artifacts`;
    open.append(description, facts);
    open.addEventListener("click", () =>
      navigate({ kind: "project", projectId: project.id, view: "overview" }),
    );
    list.append(open);
  }
  section.append(heading, list);
  content.replaceChildren(section);
}

function renderProjectAuthorizationLoading(content: HTMLElement | null): void {
  if (!content) return;
  const section = document.createElement("section");
  section.className = "empty-state reveal";
  const heading = document.createElement("h1");
  heading.textContent = "Checking project access";
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  status.textContent = "Refreshing current membership and role before loading project data.";
  section.append(heading, status);
  content.replaceChildren(section);
}

async function authorizeAndRenderProject(
  route: Extract<AppRoute, { kind: "project" }>,
  renderGeneration: number,
): Promise<void> {
  const signal = projectRouteController.signal;
  try {
    const [listReply, detailReply] = await Promise.all([
      api<{ projects: Project[] }>("/projects", { signal }),
      api<{ project: Project }>(`/projects/${route.projectId}`, { signal }),
    ]);
    if (signal.aborted || !coordinator.isCurrent(renderGeneration)) return;
    const freshProject = resolveCurrentProject(
      route.projectId,
      listReply.projects,
      detailReply.project,
    );
    if (!freshProject) throw new ApiError(404, "NOT_FOUND");
    projects = listReply.projects.map((project) =>
      project.id === freshProject.id ? freshProject : project,
    );
    activeProjectId = freshProject.id;
    activeWorkspaceId = freshProject.workspace_id;
    localStorage.setItem("context-hub-project", freshProject.id);
    populateNavigation();
    renderProject(freshProject, route.view);
    focusCurrentView();
  } catch (cause) {
    if (signal.aborted || !coordinator.isCurrent(renderGeneration)) return;
    if (cause instanceof ApiError && cause.status === 401) {
      renderLoggedOut("Your session expired. Sign in again.");
      return;
    }
    if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404)) {
      projects = projects.filter((project) => project.id !== route.projectId);
      if (activeProjectId === route.projectId) {
        activeProjectId = "";
        localStorage.removeItem("context-hub-project");
      }
      coordinator.navigate({ kind: "global", view: "projects" }, true);
      renderDashboard();
      focusCurrentView();
      return;
    }
    const content = root?.querySelector<HTMLElement>("[data-content]");
    if (!content) return;
    const section = document.createElement("section");
    section.className = "empty-state reveal";
    const heading = document.createElement("h1");
    heading.textContent = "Project access unavailable";
    const copy = document.createElement("p");
    copy.textContent =
      "Current membership could not be verified. No cached project data or controls are shown.";
    const retry = button("Retry authorization", "primary-action");
    retry.addEventListener("click", renderDashboard);
    section.append(heading, copy, retry);
    content.replaceChildren(section);
    queueMicrotask(() => retry.focus());
  }
}

function renderDashboard(): void {
  if (!root || !user) return;
  const renderGeneration = coordinator.beginRender();
  projectRouteController.abort();
  projectRouteController = new AbortController();
  unmountProjectView?.();
  unmountProjectView = null;
  root.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <a class="wordmark" href="/projects" aria-label="Context Hub projects">CH<span>/</span>02</a>
        <nav class="global-nav" aria-label="Global navigation">
          <button type="button" data-global-view="projects">Projects</button>
          <button type="button" data-global-view="activity">Activity</button>
          <button type="button" data-global-view="settings">Settings</button>
        </nav>
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
        <div class="invitation-inbox" data-invitation-inbox aria-live="polite"></div>
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

  if (coordinator.route.kind === "global") {
    projectForWorkspace();
    populateNavigation();
  }
  root.querySelectorAll<HTMLButtonElement>("[data-global-view]").forEach((control) => {
    const globalView = control.dataset.globalView as "projects" | "activity" | "settings";
    const active = coordinator.route.kind === "global" && coordinator.route.view === globalView;
    if (active) control.setAttribute("aria-current", "page");
    control.classList.toggle("global-nav--active", active);
    control.addEventListener("click", () => navigate({ kind: "global", view: globalView }));
  });
  const content = root.querySelector<HTMLElement>("[data-content]");
  if (coordinator.route.kind === "project") {
    renderProjectAuthorizationLoading(content);
    void authorizeAndRenderProject(coordinator.route, renderGeneration);
  } else if (coordinator.route.view === "activity" && content) {
    unmountProjectView = mountGlobalActivity(content, {
      onUnauthorized: () => renderLoggedOut("Your session expired. Sign in again."),
      onOpenProject: (projectId) => navigate({ kind: "project", projectId, view: "activity" }),
    });
  } else if (coordinator.route.view === "settings" && content) {
    unmountProjectView = mountGlobalSettings(content, {
      onUnauthorized: () => renderLoggedOut("Your session expired. Sign in again."),
      onProjectConfiguration: applyAuthorizedProjectConfiguration,
      onOpenProject: (projectId) => navigate({ kind: "project", projectId, view: "settings" }),
    });
  } else if (content) {
    renderProjectIndex(content);
  }

  const newProject = root.querySelector<HTMLButtonElement>("[data-new-project]");
  const canCreateProject =
    workspaces.find((workspace) => workspace.id === activeWorkspaceId)?.role === "ADMIN";
  if (newProject) newProject.hidden = !canCreateProject;
  newProject?.addEventListener("click", () => {
    showDialog(root.querySelector<HTMLDialogElement>("[data-project-dialog]"), newProject);
  });
  const newWorkspace = root.querySelector<HTMLButtonElement>("[data-new-workspace]");
  newWorkspace?.addEventListener("click", () => {
    showDialog(root.querySelector<HTMLDialogElement>("[data-workspace-dialog]"), newWorkspace);
  });
  root.querySelector<HTMLButtonElement>("[data-logout]")?.addEventListener("click", async () => {
    let message = "Session closed.";
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      message = "Private data cleared locally. Server sign-out could not be confirmed.";
    }
    renderLoggedOut(message);
  });
  bindForms();
  const inbox = root.querySelector<HTMLElement>("[data-invitation-inbox]");
  if (inbox) {
    void mountInvitationInbox(inbox, async () => {
      await refreshData();
      renderDashboard();
    });
  }
}

async function bootstrap(): Promise<void> {
  try {
    const session = await api<{ user: User }>("/auth/session");
    user = session.user;
    coordinator.markAuthenticated();
    await refreshData();
    renderDashboard();
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 401) renderLoggedOut();
    else renderLoggedOut("The control plane is unavailable. Try again shortly.");
  }
}

coordinator.mountPopstate(
  window,
  () => window.location.pathname,
  () => {
    if (coordinator.route.kind === "project") {
      activeProjectId = coordinator.route.projectId;
      activeWorkspaceId =
        projects.find((project) => project.id === activeProjectId)?.workspace_id ??
        activeWorkspaceId;
    }
    renderDashboard();
    focusCurrentView();
  },
);

void bootstrap();
