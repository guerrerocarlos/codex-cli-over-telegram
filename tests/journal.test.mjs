import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  archiveJournalMedia,
  isJournalMedia,
  loadJournalConfig,
  recoverJournalRepositories,
  zonedDateParts,
} from "../dist/journal.js";
import { Storage } from "../dist/storage.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const temp = mkdtempSync(path.join(os.tmpdir(), "telegram-journal-"));
  const remote = path.join(temp, "remote.git");
  const repo = path.join(temp, "journal");
  execFileSync("git", ["init", "--bare", remote]);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Journal Test");
  git(repo, "config", "user.email", "journal@example.test");
  writeFileSync(path.join(repo, "README.md"), "# Journal\n");
  writeFileSync(path.join(repo, "journal.config.json"), `${JSON.stringify(journalConfig)}\n`);
  git(repo, "add", "README.md", "journal.config.json");
  git(repo, "commit", "-m", "init");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-u", "origin", "main");
  return { temp, remote, repo };
}

const journalConfig = {
  version: 1,
  enabled: true,
  timezone: "America/Asuncion",
  entriesDirectory: "entries",
  indexDirectory: "indexes",
  autoCommit: true,
  autoPush: true,
  mediaKinds: ["voice", "audio", "video", "video_note", "audio-document", "video-document"],
};

test("journal config identifies voice, video, and media documents", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "journal-config-"));
  try {
    writeFileSync(path.join(dir, "journal.config.json"), `${JSON.stringify(journalConfig)}\n`);
    const config = await loadJournalConfig(dir);
    assert.equal(config.timezone, "America/Asuncion");
    assert.equal(isJournalMedia({ kind: "voice", fileId: "1", fileUniqueId: "u1", originalName: null,
      mimeType: "audio/ogg", fileSize: 1, durationSeconds: 2 }, config), true);
    assert.equal(isJournalMedia({ kind: "document", fileId: "2", fileUniqueId: "u2", originalName: "clip.mp4",
      mimeType: "video/mp4", fileSize: 1, durationSeconds: null }, config), true);
    assert.equal(isJournalMedia({ kind: "photo", fileId: "3", fileUniqueId: "u3", originalName: null,
      mimeType: "image/jpeg", fileSize: 1, durationSeconds: null }, config), false);
    assert.equal(zonedDateParts(new Date("2026-11-17T12:34:56Z"), "America/Asuncion").isoWithOffset,
      "2026-11-17T09:34:56-03:00");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal archive stores raw media, transcript, indexes, and one pushed commit", async () => {
  const { temp, remote, repo } = fixture();
  try {
    const source = path.join(temp, "voice.oga");
    writeFileSync(source, "raw voice bytes");
    const input = {
      appConfig: { openaiTranscriptionModel: "test-transcribe" },
      journalConfig,
      repoPath: repo,
      storedFile: { kind: "voice", absolutePath: source, relativePath: ".context/voice.oga",
        originalName: "voice.oga", mimeType: "audio/ogg", fileSize: 15 },
      fileRef: { kind: "voice", fileId: "file-1", fileUniqueId: "unique-voice-1", originalName: "voice.oga",
        mimeType: "audio/ogg", fileSize: 15, durationSeconds: 4 },
      telegramMessageId: 123,
      capturedAt: new Date("2026-11-17T12:34:56Z"),
      authorUsername: "@tester",
    };
    const result = await archiveJournalMedia(input, { transcribe: async () => "A journal transcript." });
    assert.equal(result.duplicate, false);
    assert.equal(result.pushed, true);
    assert.match(result.entryPath, /^entries\/2026\/11\/17\//);
    assert.equal(readFileSync(path.join(repo, result.entryPath, "raw.oga"), "utf8"), "raw voice bytes");
    assert.match(readFileSync(path.join(repo, result.entryPath, "transcript.md"), "utf8"), /A journal transcript\./);
    const metadata = JSON.parse(readFileSync(path.join(repo, result.entryPath, "metadata.json"), "utf8"));
    assert.equal(metadata.transcription.status, "complete");
    assert.equal(metadata.source.messageId, 123);
    assert.match(readFileSync(path.join(repo, "indexes", "2026", "11.md"), "utf8"), /2026-11-17T09:34:56-03:00/);
    assert.equal(git(repo, "status", "--short"), "");
    assert.equal(git(remote, "log", "-1", "--format=%s", "main"), path.basename(result.entryPath).replace(/^/, "journal: add "));

    const duplicate = await archiveJournalMedia(input, { transcribe: async () => {
      throw new Error("duplicate should not transcribe");
    } });
    assert.equal(duplicate.duplicate, true);
    assert.equal(git(repo, "rev-list", "--count", "HEAD"), "2");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("journal archive commits raw media and retryable metadata when transcription fails", async () => {
  const { temp, repo } = fixture();
  try {
    const source = path.join(temp, "video.mp4");
    writeFileSync(source, "raw video bytes");
    const result = await archiveJournalMedia({
      appConfig: { openaiTranscriptionModel: "test-transcribe" },
      journalConfig,
      repoPath: repo,
      storedFile: { kind: "video", absolutePath: source, relativePath: ".context/video.mp4",
        originalName: "video.mp4", mimeType: "video/mp4", fileSize: 15 },
      fileRef: { kind: "video", fileId: "file-2", fileUniqueId: "unique-video-2", originalName: "video.mp4",
        mimeType: "video/mp4", fileSize: 15, durationSeconds: 8 },
      telegramMessageId: 124,
      capturedAt: new Date("2026-11-17T13:00:00Z"),
      authorUsername: "@tester",
    }, { transcribe: async () => { throw new Error("transcription unavailable"); } });
    assert.equal(result.pushed, true);
    assert.equal(result.transcriptionError, "transcription unavailable");
    const metadata = JSON.parse(readFileSync(path.join(repo, result.entryPath, "metadata.json"), "utf8"));
    assert.equal(metadata.transcription.status, "failed");
    assert.equal(metadata.media.rawFile, "raw.mp4");
    assert.equal(git(repo, "status", "--short"), "");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("journal startup recovery commits a complete partially staged entry", async () => {
  const { temp, repo, remote } = fixture();
  const storage = new Storage(path.join(temp, "state.sqlite"));
  try {
    storage.upsertBinding({ chatId: -1, messageThreadId: 5701, topicName: "Journal", repoPath: repo,
      createdByUserId: 1, sandboxMode: "workspace-write", modelProvider: "openai" });
    const entryPath = path.join(repo, "entries", "2026", "11", "17", "recovery-entry");
    execFileSync("mkdir", ["-p", entryPath]);
    writeFileSync(path.join(entryPath, "raw.oga"), "raw");
    writeFileSync(path.join(entryPath, "transcript.md"), "Recovered transcript.\n");
    writeFileSync(path.join(entryPath, "metadata.json"), JSON.stringify({
      id: "recovery-entry",
      capturedAt: "2026-11-17T10:00:00-03:00",
      source: { messageId: 200, fileUniqueId: "recovery-file", kind: "voice" },
      media: { sha256: "abc" },
      transcription: { status: "complete" },
    }));
    git(repo, "add", path.relative(repo, entryPath));

    const results = await recoverJournalRepositories(storage);
    assert.equal(results.length, 1);
    assert.equal(results[0].recovered, true);
    assert.equal(results[0].pushed, true);
    assert.equal(git(repo, "status", "--short"), "");
    assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "journal: recover pending entries");
  } finally {
    storage.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
