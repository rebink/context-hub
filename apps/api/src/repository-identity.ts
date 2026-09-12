export function normalizeGithubRepository(value: string): string | null {
  const input = value.trim();
  let owner: string | undefined;
  let repository: string | undefined;
  const scp = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(input);
  if (scp) {
    [, owner, repository] = scp;
  } else {
    try {
      const url = new URL(input);
      if (
        !["https:", "ssh:"].includes(url.protocol) ||
        url.hostname.toLowerCase() !== "github.com" ||
        url.port
      )
        return null;
      if (url.search || url.hash || (url.username && url.username !== "git") || url.password)
        return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 2) return null;
      [owner, repository] = parts;
    } catch {
      return null;
    }
  }
  repository = repository?.replace(/\.git$/i, "");
  if (
    !owner ||
    !repository ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository)
  )
    return null;
  return `github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}
