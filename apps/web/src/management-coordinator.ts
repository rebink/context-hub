import { type AppRoute, appRoutePath, parseAppRouteResult, sameRoute } from "./navigation.js";

export type HistoryPort = {
  pushState(data: unknown, unused: string, url?: string | URL | null): void;
  replaceState(data: unknown, unused: string, url?: string | URL | null): void;
};

type ProjectRole = "ADMIN" | "EDITOR" | "VIEWER";

export function resolveCurrentProject<T extends { id: string; role: ProjectRole }>(
  projectId: string,
  listedProjects: readonly T[],
  detail: T,
): T | null {
  const listed = listedProjects.find((project) => project.id === projectId);
  if (detail.id !== projectId || !listed) return null;
  const privilege: Record<ProjectRole, number> = { VIEWER: 0, EDITOR: 1, ADMIN: 2 };
  const role = privilege[listed.role] < privilege[detail.role] ? listed.role : detail.role;
  return { ...detail, role };
}

export function restoreFocusAfterDialog(target: Pick<HTMLElement, "focus" | "isConnected">): void {
  if (target.isConnected) target.focus();
}

export class ManagementCoordinator {
  route: AppRoute;
  authenticated = false;
  generation = 0;

  constructor(
    pathname: string,
    private readonly history: HistoryPort,
    private readonly onClearPrivateState: () => void = () => {},
  ) {
    const parsed = parseAppRouteResult(pathname);
    this.route = parsed.route;
    if (!parsed.valid) this.history.replaceState({}, "", "/projects");
  }

  markAuthenticated(): void {
    this.authenticated = true;
  }

  clearAuthentication(): void {
    this.authenticated = false;
    this.onClearPrivateState();
    this.route = { kind: "global", view: "projects" };
    this.generation += 1;
  }

  beginRender(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return this.authenticated && generation === this.generation;
  }

  navigate(route: AppRoute, replace = false): void {
    if (!sameRoute(this.route, route) || replace) {
      this.history[replace ? "replaceState" : "pushState"]({}, "", appRoutePath(route));
    }
    this.route = route;
    this.generation += 1;
  }

  popstate(pathname: string): void {
    const parsed = parseAppRouteResult(pathname);
    this.route = parsed.route;
    this.generation += 1;
    if (!parsed.valid) this.history.replaceState({}, "", "/projects");
  }

  projectAriaCurrent(projectId: string): "page" | null {
    return this.route.kind === "project" && this.route.projectId === projectId ? "page" : null;
  }

  mountPopstate(
    target: Pick<EventTarget, "addEventListener" | "removeEventListener">,
    pathname: () => string,
    onChange: () => void,
  ): () => void {
    const listener = () => {
      this.popstate(pathname());
      onChange();
    };
    target.addEventListener("popstate", listener);
    return () => target.removeEventListener("popstate", listener);
  }
}
