import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { PassThrough } from "node:stream";
import { formatJournalDaemonArchiveResult, readImport } from "../dist/journalIngest.js";
import { formatTelegramAudioArchiveResult, githubTreeUrl } from "../dist/journal.js";

test("formats USB drive archive results for the bound Journal topic", () => {
  const message = formatJournalDaemonArchiveResult({
    duplicate: false,
    entryPath: "entries/2026/11/24/usb-audio",
    transcriptPath: "entries/2026/11/24/usb-audio/transcript.md",
    transcriptionStatus: "completed",
    transcriptionError: null,
    commitHash: "abc123",
    pushed: true,
    pushError: null,
  }, "https://github.com/guerrerocarlos/journal/tree/main/entries/2026/11/24/usb-audio");
  assert.equal(message, [
    "USB Drive Audio received.",
    "",
    "https://github.com/guerrerocarlos/journal/tree/main/entries/2026/11/24/usb-audio",
  ].join("\n"));
});

test("builds a Journal entry URL from supported GitHub remotes", () => {
  const entry = "entries/2026/11/24/usb-audio";
  assert.equal(githubTreeUrl("git@github.com:guerrerocarlos/journal.git", entry), "https://github.com/guerrerocarlos/journal/tree/main/entries/2026/11/24/usb-audio");
  assert.equal(githubTreeUrl("https://github.com/guerrerocarlos/journal.git", entry), "https://github.com/guerrerocarlos/journal/tree/main/entries/2026/11/24/usb-audio");
  assert.equal(githubTreeUrl("https://example.com/journal.git", entry), null);
});

test("formats direct Telegram audio results as a compact Journal link", () => {
  const message = formatTelegramAudioArchiveResult({ duplicate: false }, "https://github.com/guerrerocarlos/journal/tree/main/entries/example");
  assert.equal(message, "Telegram Audio received.\n\nhttps://github.com/guerrerocarlos/journal/tree/main/entries/example");
});

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
