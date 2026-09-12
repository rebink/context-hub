export type ApiOriginEnv = {
  APP_ENV?: string;
  API_ORIGIN?: string;
};

export function apiOrigin(env: ApiOriginEnv): string | null {
  if (!env.API_ORIGIN) return null;
  try {
    const parsed = new URL(env.API_ORIGIN);
    if (parsed.origin !== env.API_ORIGIN || parsed.username || parsed.password) return null;
    if (env.APP_ENV === "production") return parsed.protocol === "https:" ? parsed.origin : null;
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function callbackUrl(env: ApiOriginEnv, pathname: string): string | null {
  const origin = apiOrigin(env);
  return origin ? `${origin}${pathname}` : null;
}
