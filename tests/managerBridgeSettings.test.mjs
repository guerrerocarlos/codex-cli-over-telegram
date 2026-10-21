import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../dist/storage.js';
import { handleTelegramBridgeRequest } from '../dist/telegram.js';

const config = {
  defaultModelProvider: 'openai', defaultSandboxMode: 'read-only', alwaysYoloMode: false,
  xaiModels: ['grok-test'], claudeModels: [], xaiProviderId: 'xai', xaiBaseUrl: 'https://example.invalid',
};
const binding = (thread, name, repo) => ({ chatId: -40, messageThreadId: thread, topicName: name,
  repoPath: `/tmp/${repo}`, createdByUserId: 1, sandboxMode: 'read-only', modelProvider: 'openai' });

test('manager bridge reads and changes only topics bound to its chat', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manager-settings-'));
  const storage = new Storage(path.join(dir, 'state.sqlite'));
  try {
    const target = storage.upsertBinding(binding(101, 'API', 'inglesconliza-api'));
    storage.upsertBinding({ ...binding(102, 'Other', 'other'), chatId: -41 });
    const invoke = (request) => handleTelegramBridgeRequest({ storage, bot: {}, config, codex: {}, queue: {}, request: { chatId: -40, ...request } });

    const listed = await invoke({ action: 'list_topics' });
    assert.equal(listed.topics[0].sandboxMode, 'read-only');
    assert.equal(listed.topics[0].modelProvider, 'openai');
    const mode = await invoke({ action: 'set_topic_mode', selector: '101', sandboxMode: 'workspace-write' });
    assert.equal(mode.ok, true);
    assert.equal(storage.getBindingById(target.id).sandboxMode, 'workspace-write');
    assert.equal((await invoke({ action: 'set_topic_mode', selector: '102', sandboxMode: 'workspace-write' })).ok, false);
    assert.equal((await invoke({ action: 'set_topic_mode', selector: '101', sandboxMode: 'danger-full-access' })).ok, false);
    assert.equal((await invoke({ action: 'set_topic_model', selector: '101', modelProvider: 'xai', model: 'grok-test' })).ok, true);
    assert.equal(storage.getBindingById(target.id).model, 'grok-test');
    assert.equal((await invoke({ action: 'set_topic_model', selector: '101', modelProvider: 'xai', model: 'unlisted' })).ok, false);
    assert.equal((await invoke({ action: 'set_topic_model', selector: '101', modelProvider: 'xai', model: 'default' })).ok, true);
    assert.equal(storage.getBindingById(target.id).modelProvider, 'openai');
    assert.equal(storage.getBindingById(target.id).model, null);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
