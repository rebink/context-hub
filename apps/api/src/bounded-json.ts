export type BoundedJsonResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: "UNSUPPORTED_MEDIA_TYPE" | "PAYLOAD_TOO_LARGE" | "INVALID_INPUT" };

export async function readBoundedJsonObject(
  request: Request,
  maxBytes: number,
  requireJsonContentType = true,
): Promise<BoundedJsonResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (requireJsonContentType && contentType !== "application/json") {
    return { ok: false, error: "UNSUPPORTED_MEDIA_TYPE" };
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return { ok: false, error: "PAYLOAD_TOO_LARGE" };
  }
  if (!request.body) return { ok: false, error: "INVALID_INPUT" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false, error: "PAYLOAD_TOO_LARGE" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { ok: true, value: value as Record<string, unknown> }
      : { ok: false, error: "INVALID_INPUT" };
  } catch {
    return { ok: false, error: "INVALID_INPUT" };
  }
}
