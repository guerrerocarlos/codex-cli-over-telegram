import { realpath } from "node:fs/promises";
import path from "node:path";

export async function resolveAllowedRepoPath(
  requestedPath: string,
  allowedRoots: string[],
): Promise<string> {
  if (!path.isAbsolute(requestedPath)) {
    throw new Error("Path must be absolute.");
  }

  const repoPath = await realpath(requestedPath);
  const allowed = allowedRoots.some((root) => {
    const relative = path.relative(root, repoPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  if (!allowed) {
    throw new Error(`Path is outside allowed roots: ${allowedRoots.join(", ")}`);
  }

  return repoPath;
}
