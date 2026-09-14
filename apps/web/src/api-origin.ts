export type ApiOriginOptions = {
  pagesDeployment?: boolean;
};

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function normalizeApiOrigin(value: string, options: ApiOriginOptions = {}): string {
  if (!value) {
    if (options.pagesDeployment) throw new Error("PAGES_API_ORIGIN_REQUIRED");
    return "";
  }
  if (value !== value.trim()) throw new Error("INVALID_API_ORIGIN");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("INVALID_API_ORIGIN");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname.includes("replace-me")
  ) {
    throw new Error("INVALID_API_ORIGIN");
  }
  if (parsed.protocol !== "https:") {
    if (options.pagesDeployment || parsed.protocol !== "http:" || !isLoopback(parsed.hostname)) {
      throw new Error("INVALID_API_ORIGIN");
    }
  }
  return parsed.origin;
}
