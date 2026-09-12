export const STATE_COOKIE = "context_hub_oauth_state";
export const SESSION_COOKIE = "context_hub_session";

export function randomToken(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256Bytes(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", value);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  return sha256Bytes(new TextEncoder().encode(value));
}

export function readCookie(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie");
  if (!cookies) return null;
  for (const part of cookies.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export function cookie(
  name: string,
  value: string,
  options: { maxAge: number; secure: boolean },
): string {
  const sameSite = options.secure ? "None" : "Lax";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${options.maxAge}${options.secure ? "; Secure" : ""}`;
}

export function clearCookie(name: string, secure: boolean): string {
  const sameSite = secure ? "None" : "Lax";
  return `${name}=; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=0${secure ? "; Secure" : ""}`;
}
