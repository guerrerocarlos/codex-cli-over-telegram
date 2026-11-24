import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { CodexAppServerBackend } from '../dist/codexAppServer.js';

const config = { codexBin: path.resolve('tests/fixtures/reasoning-app-server.mjs'),
  healthHost: '127.0.0.1', healthPort: 8787, managerBridgeToken: 'test' };
const request = { bindingId: 1, chatId: -1, messageThreadId: 1, repoPath: '/tmp',
  prompt: 'test', codexThreadId: null, modelProvider: 'openai', model: null,
  modelServiceTier: null, reasoningEffort: null, planMode: false,
  sandboxMode: 'read-only', restrictedToRepo: true, approvalPolicy: 'never' };
async function run(backend, overrides = {}) {
  const events = [];
  for await (const event of backend.run({ ...request, ...overrides })) events.push(event);
  assert.equal(events.at(-1).type, 'completed', JSON.stringify(events));
  return JSON.parse(events.at(-1).finalMessage);
}

test('same topic reuses connection, initializes/loads once, supports compaction and explicit close', async (t) => {
  const backend = new CodexAppServerBackend(config);
  t.after(() => backend.shutdown());
  const first = await run(backend);
  const second = await run(backend, { codexThreadId: 'thread-test' });
  assert.equal(first.pid, second.pid);
  assert.equal(second.turns, 2);
  assert.equal(second.initializes, 1);
  assert.equal(second.starts, 1);
  assert.equal(second.resumes, 0);
  await backend.compactThread('thread-test');
  const third = await run(backend, { codexThreadId: 'thread-test' });
  assert.equal(third.pid, first.pid);
  assert.equal(backend.closeSession(1), true);
  assert.equal(backend.closeSession(1), false);
  const reopened = await run(backend, { codexThreadId: 'thread-test' });
  assert.notEqual(reopened.pid, first.pid);
  assert.equal(reopened.resumes, 1);
});

test('settings, topic identity, and reset invalidate connections', async (t) => {
  const backend = new CodexAppServerBackend(config);
  t.after(() => backend.shutdown());
  for (const change of [{ model: 'new' }, { planMode: true }, { sandboxMode: 'workspace-write' },
    { reasoningEffort: 'high' }, { chatId: -2 }, { restrictedToRepo: false }, { repoPath: '/var/tmp' },
    { codexThreadId: null }]) {
    const before = await run(backend, { codexThreadId: 'thread-test' });
    const after = await run(backend, { codexThreadId: 'thread-test', ...change });
    assert.notEqual(before.pid, after.pid, JSON.stringify(change));
  }
  const first = await run(backend, { codexThreadId: 'thread-test' });
  const other = await run(backend, { bindingId: 2, codexThreadId: 'thread-test' });
  assert.notEqual(first.pid, other.pid);
});

test('unmanaged autonomous turns are interrupted until goal scheduling is implemented', async (t) => {
  for (const prompt of ['parallel', 'autonomous']) {
    const backend = new CodexAppServerBackend(config);
    t.after(() => backend.shutdown());
    const first = await run(backend, { prompt });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await run(backend, { codexThreadId: 'thread-test' });
    assert.equal(second.pid, first.pid);
    assert.equal(second.interrupts, 1);
  }
});

test('busy sessions reject close/concurrent runs; interruption and crashes allow fresh resume', async (t) => {
  const backend = new CodexAppServerBackend(config);
  t.after(() => backend.shutdown());
  const iterator = backend.run({ ...request, prompt: 'hold' })[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'started');
  assert.throws(() => backend.closeSession(1), /busy/);
  const competing = [];
  for await (const event of backend.run(request)) competing.push(event);
  assert.equal(competing[0].type, 'failed');
  const pending = iterator.next();
  for (let i = 0; i < 100 && !backend.active.has(1); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await backend.steer(1, 'extra input'), true);
  assert.equal(await backend.interrupt(1), true);
  assert.equal((await pending).value.type, 'failed');
  await iterator.next();
  assert.equal(backend.closeSession(1), false);
  const crashed = [];
  for await (const event of backend.run({ ...request, prompt: 'crash' })) crashed.push(event);
  assert.equal(crashed.at(-1).type, 'failed');
  await run(backend, { codexThreadId: 'thread-test' });
  backend.shutdown();
  assert.equal(backend.closeSession(1), false);
});
