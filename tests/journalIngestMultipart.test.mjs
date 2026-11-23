import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { PassThrough } from "node:stream";
import { readImport } from "../dist/journalIngest.js";

test("streams the journal daemon multipart wire format to a temporary file", async () => {
  const boundary = "JournalDaemon-test";
  const audio = Buffer.from("raw audio bytes");
  const digest = createHash("sha256").update(audio).digest("hex");
  const metadata = JSON.stringify({
    version: 1,
    sourceId: "dji",
    originalPath: "DJI_Audio_001/DJI_06_20241023_215816.WAV",
    sha256: digest,
    byteCount: audio.length,
    destination: { chatId: -1004361900873, messageThreadId: 5701 },
  });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="DJI_06_20241023_215816.WAV"\r\nContent-Type: audio/wav\r\n\r\n`),
    audio,
    Buffer.from("\r\n"),
    Buffer.from(`--${boundary}--\r\n`),
  ]);

  const request = new PassThrough();
  request.headers = {
    "content-type": `multipart/form-data; boundary=${boundary}`,
    "idempotency-key": `sha256:${digest}`,
  };
  request.end(body);
  const parsed = await readImport(request);
  try {
    assert.equal(parsed.metadata.sha256, digest);
    assert.equal(parsed.byteCount, audio.length);
    assert.equal(parsed.filename, "DJI_06_20241023_215816.WAV");
    assert.deepEqual(await readFile(parsed.rawPath), audio);
  } finally {
    await rm(parsed.directory, { recursive: true, force: true });
  }
});
