import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, symlink, mkdir, truncate, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../dist/storage.js';
import { startHealthServer } from '../dist/health.js';
import { handleTelegramBridgeRequest } from '../dist/telegram.js';
import { readTelegramAttachment, MAX_OUTBOUND_FILE_BYTES } from '../dist/telegramFile.js';

test('file delivery validates paths and routes documents through authenticated bridge', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'send-file-'));
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const storage = new Storage(':memory:');
  const config = { healthHost: '127.0.0.1', healthPort: 0, managerBridgeToken: 'test-only',
    allowedTelegramChatIds: new Set([-40]), telegramSendIntervalMs: 0 };
  const sends = [];
  let fail = false;
  const bot = { api: { sendDocument: async (...args) => {
    if (fail) throw new Error('Bad Request: upload rejected');
    sends.push(args);
    return { message_id: 123 };
  } } };
  for (const topic of [0, 8]) storage.upsertBinding({ chatId: -40, messageThreadId: topic,
    topicName: `topic-${topic}`, repoPath: repo, createdByUserId: 1, sandboxMode: 'read-only', modelProvider: 'openai' });
  const server = startHealthServer(config, request => handleTelegramBridgeRequest({
    storage, bot, config, request, codex: {}, queue: {},
  }));
  await once(server, 'listening');
  const invoke = async (extra = {}, token = 'test-only') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/bridge`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'send_file', chatId: -40, selector: '8', filePath: 'report.csv', ...extra }),
    });
    return { status: response.status, result: await response.json() };
  };
  try {
    await writeFile(path.join(repo, 'report.csv'), 'name,value\nexample,42\n');
    assert.equal((await readTelegramAttachment(repo, 'report.csv')).data.toString(), 'name,value\nexample,42\n');
    const sent = await invoke({ caption: 'Your report' });
    assert.equal(sent.result.ok, true);
    assert.equal(sent.result.messageId, 123);
    assert.equal(sends[0][0], -40);
    assert.equal(sends[0][1].filename, 'report.csv');
    assert.deepEqual(sends[0][2], { message_thread_id: 8, caption: 'Your report' });
    assert.equal((await invoke({ selector: '0' })).result.ok, true);
    assert.equal(sends[1][2].message_thread_id, undefined);
    assert.equal((await invoke({}, 'wrong')).status, 401);
    assert.equal((await invoke({ selector: '999' })).result.ok, false);
    assert.equal((await invoke({ chatId: -41 })).result.ok, false);
    assert.equal((await invoke({ caption: 'a'.repeat(1025) })).result.ok, false);
    await writeFile(path.join(root, 'outside.txt'), 'outside');
    await symlink(path.join(root, 'outside.txt'), path.join(repo, 'link.txt'));
    for (const filePath of ['../outside.txt', 'link.txt', '.', 'missing.txt']) {
      assert.equal((await invoke({ filePath })).result.ok, false, filePath);
    }
    await writeFile(path.join(repo, 'empty.txt'), '');
    assert.equal((await invoke({ filePath: 'empty.txt' })).result.ok, false);
    await truncate(path.join(repo, 'empty.txt'), MAX_OUTBOUND_FILE_BYTES + 1);
    assert.equal((await invoke({ filePath: 'empty.txt' })).result.ok, false);
    assert.equal(sends.length, 2);
    fail = true;
    assert.equal((await invoke()).result.ok, false);
    const listing = execFileSync(process.execPath, ['dist/managerBridgeMcp.js'], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n', encoding: 'utf8',
    });
    assert.ok(JSON.parse(listing).result.tools.find(tool => tool.name === 'send_file'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
});
