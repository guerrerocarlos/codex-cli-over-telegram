import path from "node:path";
import { constants } from "node:fs";
import { realpath, open } from "node:fs/promises";

export const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;

export async function readTelegramAttachment(repoPath: string, filePath: string): Promise<{ name: string; data: Buffer }> {
  const root = await realpath(repoPath);
  const target = await realpath(path.resolve(root, filePath));
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("File must be inside the destination topic's repo folder.");
  }
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Only regular files can be sent.");
    if (info.size === 0 || info.size > MAX_OUTBOUND_FILE_BYTES) throw new Error("File must be non-empty and at most 20 MiB.");
    // Read a bounded snapshot so queued retries send the same bytes.
    const data = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error("File changed during read; retry after writing finishes.");
    return { name: path.basename(target), data: data.subarray(0, length) };
  } finally {
    await file.close();
  }
}
