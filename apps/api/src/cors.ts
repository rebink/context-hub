export type CorsEnv = { WEB_ORIGIN?: string };

export function corsJsonHeaders(request: Request, env: CorsEnv): Headers {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  const origin = request.headers.get("origin");
  if (origin && env.WEB_ORIGIN && origin === env.WEB_ORIGIN) {
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-allow-credentials", "true");
    headers.set("vary", "origin");
  }
  return headers;
}
