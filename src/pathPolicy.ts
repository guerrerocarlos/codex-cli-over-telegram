import { mkdir, realpath } from "node:fs/promises";
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

  const requestedAbsolutePath = path.resolve(expandedPath);
  const repoPath = await resolveOrCreateAllowedPath(requestedAbsolutePath, allowedRoots);
  const allowed = isInsideAllowedRoots(repoPath, allowedRoots);

  if (!allowed) {
    throw new Error(`Path is outside allowed roots: ${allowedRoots.join(", ")}`);
  }

  return repoPath;
}

async function resolveOrCreateAllowedPath(requestedPath: string, allowedRoots: string[]): Promise<string> {
  try {
    return await realpath(requestedPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (!isInsideAllowedRoots(requestedPath, allowedRoots)) {
    throw new Error(`Path is outside allowed roots: ${allowedRoots.join(", ")}`);
  }

  await mkdir(requestedPath, { recursive: true });
  return await realpath(requestedPath);
}

function isInsideAllowedRoots(candidatePath: string, allowedRoots: string[]): boolean {
  return allowedRoots.some((root) => {
    const relative = path.relative(root, candidatePath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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
