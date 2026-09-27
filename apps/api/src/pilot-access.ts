import { sha256 } from "./security.js";

const HASH_LIST = /^(?:[0-9a-f]{64})(?:,[0-9a-f]{64}){0,99}$/;

export type PilotAccessEnv = {
  APP_ENV?: string;
  DEPLOYMENT_PROFILE?: string;
  PILOT_GITHUB_USER_ID_HASHES?: string;
};

export function pilotAccessRequired(env: PilotAccessEnv): boolean {
  return env.APP_ENV === "production" && env.DEPLOYMENT_PROFILE === "FREE_PILOT";
}

export function pilotHashes(env: PilotAccessEnv): ReadonlySet<string> | null {
  if (!pilotAccessRequired(env)) return null;
  const value = env.PILOT_GITHUB_USER_ID_HASHES;
  if (!value || !HASH_LIST.test(value)) return null;
  return new Set(value.split(","));
}

export async function pilotAllows(
  env: PilotAccessEnv,
  provider: string,
  providerUserId: string,
): Promise<boolean> {
  const hashes = pilotHashes(env);
  if (!pilotAccessRequired(env)) return true;
  if (!hashes || provider !== "github") return false;
  return hashes.has(await sha256(`${provider}:${providerUserId}`));
}
