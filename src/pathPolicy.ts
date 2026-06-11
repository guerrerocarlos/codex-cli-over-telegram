import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function resolveAllowedRepoPath(
  requestedPath: string,
  allowedRoots: string[],
): Promise<string> {
  const expandedPath = expandHomePath(requestedPath);
  if (!path.isAbsolute(expandedPath)) {
    throw new Error("Path must be absolute.");
  }

  const repoPath = await realpath(expandedPath);
  const allowed = allowedRoots.some((root) => {
    const relative = path.relative(root, repoPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });

  if (!allowed) {
    throw new Error(`Path is outside allowed roots: ${allowedRoots.join(", ")}`);
  }

  return repoPath;
}

function expandHomePath(requestedPath: string): string {
  if (requestedPath === "~") {
    return os.homedir();
  }
  if (requestedPath.startsWith("~/")) {
    return path.join(os.homedir(), requestedPath.slice(2));
  }
  if (requestedPath.startsWith("~")) {
    throw new Error("Only ~ and ~/ paths are supported; ~user expansion is not supported.");
  }
  return requestedPath;
}
