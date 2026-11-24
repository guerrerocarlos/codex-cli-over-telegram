import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '../dist/storage.js';
import { createTelegramBot } from '../dist/telegram.js';

async function setup(t, extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'quiet-output-'));
  const storage = new Storage(path.join(dir, 'state.sqlite'));
  t.after(() => { storage.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = { telegramBotToken: '123456:test', allowedTelegramUserIds: new Set([1]),
    allowedTelegramChatIds: new Set([-1]), telegramSendIntervalMs: 0,
    maxTelegramMessageChars: 4000, maxParallelRuns: 1, allowUnthreadedChats: true,
    defaultModelProvider: 'openai', defaultSandboxMode: 'read-only', ...extra };
  const binding = storage.upsertBinding({ chatId: -1, messageThreadId: 1, topicName: 'test',
    repoPath: dir, createdByUserId: 1, sandboxMode: 'read-only', modelProvider: 'openai' });
  storage.updateBindingThread(binding.id, 'test-no-images');
  const closed = [];
  const backend = { closeSession(id) { closed.push(id); return true; }, async *run() {
    yield { type: 'agent_message', text: 'Working on your request.' };
    yield { type: 'command_started', text: 'SECRET_COMMAND' };
    yield { type: 'command_completed', text: 'RAW_OUTPUT' };
    yield { type: 'file_changed', text: 'CHANGED_FILE', paths: ['example.ts'] };
    yield { type: 'permission_request', approvalId: 'test', reason: 'Human approval', permissions: {} };
    yield { type: 'agent_message', text: 'Here is your answer:\n```js\nconsole.log(42);\n```' };
    yield { type: 'completed' };
  } };
  const bot = createTelegramBot(config, storage, backend);
  const messages = [];
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'getMe') return { ok: true, result: { id: 2, is_bot: true, first_name: 'Test', username: 'TestBot' } };
    if (method === 'sendMessage') messages.push(payload);
    return { ok: true, result: { message_id: messages.length + 1, date: 0, chat: { id: -1, type: 'supergroup' } } };
  });
  await bot.init();
  let id = 0;
  const command = (text, user = 1) => bot.handleUpdate({ update_id: ++id, message: {
    message_id: id, date: 0, message_thread_id: 1, chat: { id: -1, type: 'supergroup' },
    from: { id: user, is_bot: false, first_name: 'Tester' }, text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
  } });
  return { command, messages, storage, binding, closed };
}

test('quiet default hides execution logs, keeps human messages, code examples and approval buttons', async (t) => {
  for (const verbose of [undefined, true]) {
    const { command, messages, storage, binding } = await setup(t, { telegramToolOutput: verbose });
    await command('/ask test');
    for (let i = 0; i < 200 && storage.getActiveRun(binding.id); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(storage.getActiveRun(binding.id), null);
    // Completion status is persisted just before final Telegram delivery.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const text = messages.map((message) => message.text).join('\n');
    assert.match(text, /Working on your request/);
    assert.match(text, /Here is your answer/);
    assert.match(text, /console/);
    assert.equal(messages.some((message) => message.reply_markup?.inline_keyboard), true);
    for (const technical of ['SECRET_COMMAND', 'RAW_OUTPUT', 'CHANGED_FILE']) {
      // Markdown escaping inserts backslashes in underscore-containing text.
      assert.equal(text.replaceAll('\\', '').includes(technical), Boolean(verbose));
    }
  }
});

test('/close preserves thread, /new resets it, authorization and active-run guard apply', async (t) => {
  const { command, storage, binding, closed } = await setup(t);
  await command('/close', 99);
  assert.deepEqual(closed, []);
  await command('/close');
  assert.deepEqual(closed, [binding.id]);
  assert.equal(storage.getBindingById(binding.id).codexThreadId, 'test-no-images');
  const run = storage.createRun(binding.id, 1, 'hold', false);
  await command('/close');
  await command('/new');
  assert.equal(closed.length, 1);
  assert.equal(storage.getBindingById(binding.id).codexThreadId, 'test-no-images');
  storage.completeRun(run.id, 'done');
  await command('/new');
  assert.equal(closed.length, 2);
  assert.equal(storage.getBindingById(binding.id).codexThreadId, null);
});
