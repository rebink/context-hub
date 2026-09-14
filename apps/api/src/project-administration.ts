import { readBoundedJsonObject } from "./bounded-json.js";
import { corsJsonHeaders } from "./cors.js";
import type { Env } from "./index.js";

type User = { id: string };
type ProjectSettingsRow = {
  id: string;
  workspace_id: string;
  name: string;
  slug: string;
  description: string | null;
  status: string;
  role: "ADMIN" | "EDITOR" | "VIEWER";
  settings_revision: number;
  member_count: number;
  artifact_count: number;
};

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY_BYTES = 2 * 1024;

function response(
  request: Request,
  env: Env,
  body: Record<string, unknown>,
  status = 200,
): Response {
  return Response.json(body, { status, headers: corsJsonHeaders(request, env) });
}

function failure(request: Request, env: Env, code: string, status: number): Response {
  return response(request, env, { error: code }, status);
}

function exactKeys(body: Record<string, unknown>): boolean {
  const expected = ["description", "expectedRevision", "name", "slug"];
  const actual = Object.keys(body).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function revision(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) < 2_147_483_647
    ? Number(value)
    : null;
}

function normalizedString(
  value: unknown,
  max: number,
  required: boolean,
): string | null | undefined {
  if (value === null && !required) return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length > max || (required && normalized.length === 0)) return undefined;
  return normalized || null;
}

async function currentProject(env: Env, projectId: string, userId: string) {
  return (
    (await env.DB.prepare(
      `SELECT p.id,p.workspace_id,p.name,p.slug,p.description,p.status,p.settings_revision,pm.role,
              (SELECT COUNT(*) FROM project_members members WHERE members.project_id=p.id) AS member_count,
              (SELECT COUNT(*) FROM artifacts artifact WHERE artifact.project_id=p.id AND artifact.status='ACTIVE') AS artifact_count
       FROM projects p JOIN project_members pm ON pm.project_id=p.id
       WHERE p.id=? AND p.status='ACTIVE' AND pm.user_id=?`,
    )
      .bind(projectId, userId)
      .first<ProjectSettingsRow>()) ?? null
  );
}

function publicProject(project: ProjectSettingsRow) {
  return {
    id: project.id,
    workspace_id: project.workspace_id,
    name: project.name,
    slug: project.slug,
    description: project.description,
    status: project.status,
    role: project.role,
    settings_revision: project.settings_revision,
    member_count: project.member_count,
    artifact_count: project.artifact_count,
  };
}

function isSettingsConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes("UNIQUE constraint failed: projects.workspace_id, projects.slug") ||
    error.message.includes("invalid project settings transition")
  );
}

export async function handleProjectAdministration(
  request: Request,
  env: Env,
  user: User,
  projectId: string,
): Promise<Response> {
  if (request.method !== "PATCH") return failure(request, env, "METHOD_NOT_ALLOWED", 405);
  if (!ID.test(projectId)) return failure(request, env, "INVALID_INPUT", 400);
  const current = await currentProject(env, projectId, user.id);
  if (!current) return failure(request, env, "NOT_FOUND", 404);
  if (request.headers.get("origin") !== env.WEB_ORIGIN)
    return failure(request, env, "ORIGIN_NOT_ALLOWED", 403);
  if (current.role !== "ADMIN") return failure(request, env, "FORBIDDEN", 403);

  const parsed = await readBoundedJsonObject(request, MAX_BODY_BYTES);
  if (!parsed.ok) {
    const status =
      parsed.error === "UNSUPPORTED_MEDIA_TYPE"
        ? 415
        : parsed.error === "PAYLOAD_TOO_LARGE"
          ? 413
          : 400;
    return failure(request, env, parsed.error, status);
  }
  if (!exactKeys(parsed.value)) return failure(request, env, "INVALID_INPUT", 400);
  const name = normalizedString(parsed.value.name, 100, true);
  const slug = normalizedString(parsed.value.slug, 63, true);
  const description = normalizedString(parsed.value.description, 500, false);
  const expectedRevision = revision(parsed.value.expectedRevision);
  if (!name || !slug || description === undefined || !SLUG.test(slug) || !expectedRevision) {
    return failure(request, env, "INVALID_INPUT", 400);
  }
  if (expectedRevision !== current.settings_revision) {
    return response(
      request,
      env,
      { error: "CONFLICT", currentRevision: current.settings_revision },
      409,
    );
  }
  if (name === current.name && slug === current.slug && description === current.description) {
    const latest = await currentProject(env, projectId, user.id);
    if (
      latest?.role !== "ADMIN" ||
      latest.settings_revision !== expectedRevision ||
      latest.name !== name ||
      latest.slug !== slug ||
      latest.description !== description
    ) {
      return response(
        request,
        env,
        { error: "CONFLICT", currentRevision: latest?.settings_revision ?? expectedRevision },
        409,
      );
    }
    return response(request, env, { project: publicProject(latest), unchanged: true });
  }

  let updated: Pick<
    ProjectSettingsRow,
    "name" | "slug" | "description" | "settings_revision"
  > | null;
  try {
    updated = await env.DB.prepare(
      `UPDATE projects SET name=?,slug=?,description=?,settings_revision=settings_revision+1,
         settings_updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),settings_updated_by=?,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=? AND status='ACTIVE' AND settings_revision=?
         AND EXISTS(SELECT 1 FROM project_members admin WHERE admin.project_id=projects.id AND admin.user_id=? AND admin.role='ADMIN')
       RETURNING name,slug,description,settings_revision`,
    )
      .bind(name, slug, description, user.id, projectId, expectedRevision, user.id)
      .first();
  } catch (error) {
    if (!isSettingsConflict(error)) throw error;
    const latest = await currentProject(env, projectId, user.id);
    return response(
      request,
      env,
      { error: "CONFLICT", currentRevision: latest?.settings_revision ?? expectedRevision },
      409,
    );
  }
  if (!updated) {
    const latest = await currentProject(env, projectId, user.id);
    return response(
      request,
      env,
      { error: "CONFLICT", currentRevision: latest?.settings_revision ?? expectedRevision },
      409,
    );
  }
  return response(request, env, {
    project: publicProject({ ...current, ...updated }),
    unchanged: false,
  });
}
