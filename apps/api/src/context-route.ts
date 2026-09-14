import { ContextAuthorizationError, ContextAuthorizationFence } from "./context-authorization.js";
import { ContextBudgetError, ContextEngine } from "./context-engine.js";
import type { ContextQuery, CrossProjectContextQuery } from "./context-provider.js";
import type { ObjectStorage } from "./object-storage.js";

export type ContextEnv = { DB: D1Database; WEB_ORIGIN?: string };
export type ContextUser = { id: string };

const ID = /^[A-Za-z0-9_-]+$/;
const MAX_BODY_BYTES = 4 * 1024;
const MIN_TOKENS = 32;
const MAX_TOKENS = 8_000;
const MIN_BYTES = 512;
const MAX_BYTES = 64 * 1024;
const MIN_SOURCES = 1;
const MAX_SOURCES = 80;
const MAX_PROJECTS = 20;

type Role = "ADMIN" | "EDITOR" | "VIEWER";

function reply(request: Request, env: ContextEnv, value: unknown, status = 200): Response {
  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
  });
  const origin = request.headers.get("origin");
  if (origin && origin === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return Response.json(value, { status, headers });
}

async function parseInput(
  request: Request,
  projectId?: string,
): Promise<ContextQuery | CrossProjectContextQuery | null> {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return null;
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const allowedKeys = projectId
    ? ["query", "domain", "package", "budget"]
    : ["projectIds", "query", "domain", "package", "budget"];
  if (Object.keys(body).some((key) => !allowedKeys.includes(key))) return null;
  let projectIds: string[] | undefined;
  if (!projectId) {
    if (
      !Array.isArray(body.projectIds) ||
      body.projectIds.length < 1 ||
      body.projectIds.length > MAX_PROJECTS ||
      body.projectIds.some((id) => typeof id !== "string" || !ID.test(id)) ||
      new Set(body.projectIds).size !== body.projectIds.length
    )
      return null;
    projectIds = [...body.projectIds].sort() as string[];
  }
  if (
    typeof body.query !== "string" ||
    body.query.trim().length < 2 ||
    body.query.trim().length > 500
  )
    return null;
  if (
    body.domain !== undefined &&
    (typeof body.domain !== "string" ||
      body.domain.trim().length < 1 ||
      body.domain.trim().length > 100)
  )
    return null;
  if (
    body.package !== undefined &&
    (typeof body.package !== "string" ||
      body.package.trim().length < 1 ||
      body.package.trim().length > 160)
  )
    return null;
  if (!body.budget || typeof body.budget !== "object" || Array.isArray(body.budget)) return null;
  const budget = body.budget as Record<string, unknown>;
  if (Object.keys(budget).some((key) => !["maxTokens", "maxBytes", "maxSources"].includes(key)))
    return null;
  if (
    !Number.isSafeInteger(budget.maxTokens) ||
    (budget.maxTokens as number) < MIN_TOKENS ||
    (budget.maxTokens as number) > MAX_TOKENS
  )
    return null;
  if (
    !Number.isSafeInteger(budget.maxBytes) ||
    (budget.maxBytes as number) < MIN_BYTES ||
    (budget.maxBytes as number) > MAX_BYTES
  )
    return null;
  if (
    budget.maxSources !== undefined &&
    (!Number.isSafeInteger(budget.maxSources) ||
      (budget.maxSources as number) < MIN_SOURCES ||
      (budget.maxSources as number) > MAX_SOURCES)
  )
    return null;
  const common = {
    query: body.query.trim(),
    ...(body.domain === undefined ? {} : { domain: (body.domain as string).trim() }),
    ...(body.package === undefined ? {} : { package: (body.package as string).trim() }),
    budget: {
      maxTokens: budget.maxTokens as number,
      maxBytes: budget.maxBytes as number,
      ...(budget.maxSources === undefined ? {} : { maxSources: budget.maxSources as number }),
    },
  };
  return projectId ? { projectId, ...common } : { projectIds: projectIds ?? [], ...common };
}

export async function handleContextRoute(
  request: Request,
  env: ContextEnv,
  storage: ObjectStorage,
  user: ContextUser,
  projectId: string,
): Promise<Response> {
  if (!ID.test(projectId)) return reply(request, env, { error: "INVALID_INPUT" }, 400);
  if (request.method !== "POST") return reply(request, env, { error: "METHOD_NOT_ALLOWED" }, 405);
  if (request.headers.get("origin") !== env.WEB_ORIGIN)
    return reply(request, env, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  const input = await parseInput(request, projectId);
  if (!input || !("projectId" in input))
    return reply(request, env, { error: "INVALID_INPUT" }, 400);
  const membership = await env.DB.prepare(
    `SELECT pm.role FROM project_members pm JOIN projects p ON p.id = pm.project_id
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=pm.user_id
     WHERE pm.project_id = ? AND pm.user_id = ? AND p.status='ACTIVE'
       AND pm.role IN ('ADMIN','EDITOR','VIEWER')`,
  )
    .bind(projectId, user.id)
    .first<{ role: Role }>();
  if (!membership) return reply(request, env, { error: "NOT_FOUND" }, 404);
  try {
    const fence = ContextAuthorizationFence.human([projectId], user.id);
    return reply(request, env, await new ContextEngine(env.DB, storage, fence).search(input));
  } catch (cause) {
    if (cause instanceof ContextAuthorizationError)
      return reply(request, env, { error: "NOT_FOUND" }, 404);
    if (cause instanceof ContextBudgetError)
      return reply(request, env, { error: "INVALID_INPUT" }, 400);
    return reply(request, env, { error: "CONTEXT_UNAVAILABLE" }, 503);
  }
}

export async function handleCrossProjectContextRoute(
  request: Request,
  env: ContextEnv,
  storage: ObjectStorage,
  user: ContextUser,
): Promise<Response> {
  if (request.method !== "POST") return reply(request, env, { error: "METHOD_NOT_ALLOWED" }, 405);
  if (request.headers.get("origin") !== env.WEB_ORIGIN)
    return reply(request, env, { error: "ORIGIN_NOT_ALLOWED" }, 403);
  const input = await parseInput(request);
  if (!input || !("projectIds" in input))
    return reply(request, env, { error: "INVALID_INPUT" }, 400);

  const placeholders = input.projectIds.map(() => "?").join(",");
  const authorization = await env.DB.prepare(
    `SELECT COUNT(*) AS authorized_count FROM projects p
     JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=?
     JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
     WHERE p.status='ACTIVE' AND pm.role IN ('ADMIN','EDITOR','VIEWER')
       AND p.id IN (${placeholders})`,
  )
    .bind(user.id, user.id, ...input.projectIds)
    .first<{ authorized_count: number }>();
  if (authorization?.authorized_count !== input.projectIds.length)
    return reply(request, env, { error: "NOT_FOUND" }, 404);

  try {
    const fence = ContextAuthorizationFence.human(input.projectIds, user.id);
    return reply(request, env, await new ContextEngine(env.DB, storage, fence).searchMany(input));
  } catch (cause) {
    if (cause instanceof ContextAuthorizationError)
      return reply(request, env, { error: "NOT_FOUND" }, 404);
    if (cause instanceof ContextBudgetError)
      return reply(request, env, { error: "INVALID_INPUT" }, 400);
    return reply(request, env, { error: "CONTEXT_UNAVAILABLE" }, 503);
  }
}
