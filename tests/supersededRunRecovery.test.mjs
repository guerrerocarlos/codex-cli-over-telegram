import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../dist/storage.js';

test('superseded queued runs are left untouched and never returned for restart recovery', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'superseded-run-'));
  const storage = new Storage(path.join(dir, 'state.sqlite'));
  try {
    const binding = storage.upsertBinding({
      chatId: -1003696100403,
      messageThreadId: 62845,
      topicName: 'landing',
      repoPath: path.join(dir, 'landing'),
      createdByUserId: 1,
      sandboxMode: 'workspace-write',
      modelProvider: 'openai',
    });
    const superseded = storage.createRun(binding.id, null, 'obsolete assignment');
    const interrupted = storage.createRun(binding.id, null, 'authorized assignment');
    storage.updateRunStarted(interrupted.id);

    const resumable = storage.prepareInterruptedRunsForResume(new Set([superseded.id]));

    assert.deepEqual(resumable.map((run) => run.id), [interrupted.id]);
    assert.equal(resumable[0].interruptedStatus, 'running');
    assert.equal(storage.getRun(superseded.id).status, 'queued');
    assert.equal(storage.getRun(interrupted.id).status, 'queued');
    assert.equal(storage.getActiveRun(binding.id).id, interrupted.id);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
