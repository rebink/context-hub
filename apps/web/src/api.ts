export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly currentVersion?: number,
    readonly currentRevision?: number,
    readonly currentStatus?: string,
  ) {
    super(code);
  }
}

const apiUrl = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export function loginUrl(): string {
  return `${apiUrl}/auth/github`;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  let payload:
    | (T & {
        error?: string;
        currentVersion?: number;
        currentRevision?: number;
        currentStatus?: string;
      })
    | null = null;
  try {
    payload = (await response.json()) as T & { error?: string; currentVersion?: number };
  } catch {
    // Non-JSON gateway failures are still presented as bounded request errors.
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error ?? "REQUEST_FAILED",
      payload?.currentVersion,
      payload?.currentRevision,
      payload?.currentStatus,
    );
  }
  if (!payload) throw new ApiError(500, "INVALID_RESPONSE");
  return payload;
}
