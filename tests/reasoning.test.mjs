import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../dist/storage.js';
import { createTelegramBot } from '../dist/telegram.js';
import { CodexAppServerBackend } from '../dist/codexAppServer.js';
import { codexReasoningArgs } from '../dist/modelProviders.js';

const config = {
  telegramBotToken: '123456:test', allowedTelegramUserIds: new Set([1]),
  allowedTelegramChatIds: new Set([-1]), telegramSendIntervalMs: 0,
  maxTelegramMessageChars: 4000, maxParallelRuns: 1, allowUnthreadedChats: true,
  defaultModelProvider: 'openai', codexBin: path.resolve('tests/fixtures/reasoning-app-server.mjs'),
  healthHost: '127.0.0.1', healthPort: 8787, managerBridgeToken: 'test',
};
const bindingInput = (topic) => ({ chatId: -1, messageThreadId: topic,
  topicName: 'test', repoPath: '/tmp', createdByUserId: 1,
  sandboxMode: 'read-only', modelProvider: 'openai' });

test('reasoning command isolates topics, validates input, resets, and survives reopening', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'reasoning-'));
  const dbPath = path.join(dir, 'state.sqlite');
  let storage = new Storage(dbPath);
  try {
    const first = storage.upsertBinding(bindingInput(1));
    const second = storage.upsertBinding(bindingInput(2));
    assert.equal(first.reasoningEffort, null);
    const bot = createTelegramBot(config, storage, {});
    const replies = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method === 'getMe') return { ok: true, result: { id: 2, is_bot: true, first_name: 'Test', username: 'TestBot' } };
      replies.push(payload.text);
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: -1, type: 'supergroup' } } };
    });
    await bot.init();
    let id = 0;
    const command = async (text, user = 1) => bot.handleUpdate({ update_id: ++id, message: {
      message_id: id, date: 0, message_thread_id: 1, chat: { id: -1, type: 'supergroup' },
      from: { id: user, is_bot: false, first_name: 'Tester' }, text,
      entities: [{ type: 'bot_command', offset: 0, length: 10 }],
    } });
    await command('/reasoning high');
    assert.equal(storage.getBindingById(first.id).reasoningEffort, 'high');
    assert.equal(storage.getBindingById(second.id).reasoningEffort, null);
    await command('/reasoning invalid');
    assert.equal(storage.getBindingById(first.id).reasoningEffort, 'high');
    await command('/reasoning low', 99);
    assert.equal(storage.getBindingById(first.id).reasoningEffort, 'high');
    await command('/reasoning');
    assert.match(replies.at(-1), /high/);
    await command('/reasoning default');
    assert.equal(storage.getBindingById(first.id).reasoningEffort, null);
    await command('/reasoning');
    assert.match(replies.at(-1), /medium/);
    await command('/reasoning xhigh');
    storage.close();
    storage = new Storage(dbPath);
    assert.equal(storage.getBindingById(first.id).reasoningEffort, 'xhigh');
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('app-server applies override and resolves default for resumed threads', async () => {
  for (const reasoningEffort of ['high', null]) {
    const backend = new CodexAppServerBackend(config);
    const events = [];
    for await (const event of backend.run({ ...bindingInput(1), bindingId: 1,
      prompt: 'test', codexThreadId: 'thread-test', model: null, modelServiceTier: null,
      reasoningEffort, approvalPolicy: 'never', restrictedToRepo: true, planMode: false })) events.push(event);
    assert.equal(events.at(-1).type, 'completed', JSON.stringify(events));
    const actual = JSON.parse(events.at(-1).finalMessage);
    assert.equal(actual.effort, reasoningEffort ?? 'medium');
    assert.equal(actual.args.includes('model_reasoning_effort="high"'), reasoningEffort === 'high');
  }
  assert.deepEqual(codexReasoningArgs(null), []);
  assert.deepEqual(codexReasoningArgs('high'), ['-c', 'model_reasoning_effort="high"']);
});
