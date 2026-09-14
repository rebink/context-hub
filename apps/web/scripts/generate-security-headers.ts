import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeApiOrigin } from "../src/api-origin.js";

export type PagesHeadersInput = {
  apiUrl: string;
  pagesDeployment: boolean;
};

export function generatePagesHeaders(input: PagesHeadersInput): string {
  const apiOrigin = normalizeApiOrigin(input.apiUrl, {
    pagesDeployment: input.pagesDeployment,
  });
  const connectSources = ["'self'", ...(apiOrigin ? [apiOrigin] : [])].join(" ");
  return `/*
  Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src ${connectSources}
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Referrer-Policy: no-referrer
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY

/assets/*
  Cache-Control: public, max-age=31536000, immutable
`;
}

async function main(): Promise<void> {
  const value = generatePagesHeaders({
    apiUrl: process.env.VITE_API_URL ?? "",
    pagesDeployment: process.env.CF_PAGES === "1" || process.env.CONTEXT_HUB_PAGES_BUILD === "1",
  });
  if (process.argv.includes("--validate")) return;
  const output = fileURLToPath(new URL("../dist/_headers", import.meta.url));
  await mkdir(fileURLToPath(new URL("../dist", import.meta.url)), { recursive: true });
  await writeFile(output, value, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => {
    const code =
      error instanceof Error && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.message)
        ? error.message
        : "SECURITY_HEADERS_GENERATION_FAILED";
    console.error(code);
    process.exitCode = 1;
  });
}
