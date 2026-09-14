export const GLOBAL_VIEWS = ["projects", "activity", "settings"] as const;
export const PROJECT_VIEWS = [
  "overview",
  "context",
  "graphify",
  "git",
  "team",
  "snapshots",
  "activity",
  "settings",
] as const;

export type GlobalView = (typeof GLOBAL_VIEWS)[number];
export type ProjectView = (typeof PROJECT_VIEWS)[number];
export type AppRoute =
  | { kind: "global"; view: GlobalView }
  | { kind: "project"; projectId: string; view: ProjectView };

const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function parseAppRouteResult(pathname: string): { route: AppRoute; valid: boolean } {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { route: { kind: "global", view: "projects" }, valid: true };
  if (segments.length === 1 && GLOBAL_VIEWS.includes(segments[0] as GlobalView)) {
    return { route: { kind: "global", view: segments[0] as GlobalView }, valid: true };
  }
  if (segments[0] === "projects" && segments.length >= 2 && PROJECT_ID.test(segments[1] ?? "")) {
    const view = segments.length === 2 ? "overview" : segments[2];
    if (segments.length <= 3 && PROJECT_VIEWS.includes(view as ProjectView)) {
      return {
        route: { kind: "project", projectId: segments[1] ?? "", view: view as ProjectView },
        valid: true,
      };
    }
  }
  return { route: { kind: "global", view: "projects" }, valid: false };
}

export function parseAppRoute(pathname: string): AppRoute {
  return parseAppRouteResult(pathname).route;
}

export function appRoutePath(route: AppRoute): string {
  return route.kind === "global" ? `/${route.view}` : `/projects/${route.projectId}/${route.view}`;
}

export function sameRoute(left: AppRoute, right: AppRoute): boolean {
  return appRoutePath(left) === appRoutePath(right);
}

export function isCurrentViewRequest(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration;
}
