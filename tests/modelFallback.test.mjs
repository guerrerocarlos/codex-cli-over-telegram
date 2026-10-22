import assert from 'node:assert/strict';
import test from 'node:test';
import { runWithModelFallback, rejectedChatGptModel } from '../dist/modelFallback.js';
const message = "The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
const error = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message } });
const request = { bindingId: 1, modelProvider: 'openai', model: null, codexThreadId: 'old', modelServiceTier: 'priority' };
async function exercise(first, options = {}) {
  const calls = [], persisted = [], events = [];
  let closed = false;
  const backend = { async *run(req) {
    calls.push(req);
    if (calls.length > 1) { assert.equal(closed, true); yield options.second ?? { type: 'completed', finalMessage: 'ok' }; return; }
    try {
      for (const event of first) yield event;
      if (options.throws) throw new Error(error);
    } finally { closed = true; }
  }};
  for await (const event of runWithModelFallback(backend, { ...request, ...options.request },
    async () => { if (options.resolveThrows) throw new Error('offline'); return options.defaultModel === undefined ? 'configured-good' : options.defaultModel; },
    async (...args) => persisted.push(args))) events.push(event);
  return { calls, persisted, events };
}
test('strict rejection matching supports message and observed envelope only', () => {
  assert.equal(rejectedChatGptModel(error), 'gpt-5.5');
  assert.equal(rejectedChatGptModel(message), 'gpt-5.5');
  assert.equal(rejectedChatGptModel("The model 'gpt-6-luna' does not exist or you do not have access to it."), 'gpt-6-luna');
  assert.equal(rejectedChatGptModel("Model 'gpt-6-luna' is not available."), 'gpt-6-luna');
  for (const value of ['HTTP 400', 'quota exceeded', message + ' other text', JSON.stringify({ type: 'error', status: 500, error: { type: 'invalid_request_error', message } })]) assert.equal(rejectedChatGptModel(value), null);
});
test('stale resumed model retries once explicitly, preserves newly issued thread, persists selection', async () => {
  const result = await exercise([{ type: 'started', threadId: 'resumed' }, { type: 'progress', text: 'Codex turn started.' }, { type: 'progress', text: error }, { type: 'failed', error }]);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[1].model, 'configured-good');
  assert.equal(result.calls[1].codexThreadId, 'resumed');
  assert.equal(result.calls[1].modelServiceTier, null);
  assert.deepEqual(result.persisted, [['configured-good', 'gpt-5.5']]);
  assert.equal(result.events.at(-1).type, 'completed');
  assert.equal(result.events.some(e => e.type === 'failed'), false);
});
test('a second rejection is terminal', async () => {
  const result = await exercise([{ type: 'failed', error }], { second: { type: 'failed', error } });
  assert.equal(result.calls.length, 2);
  assert.equal(result.events.at(-1).type, 'failed');
});
test('no retry after tools, output, file changes, approval, usage or unknown progress', async () => {
  for (const type of ['work_started', 'command_started', 'command_completed', 'file_changed', 'agent_message', 'agent_message_delta', 'permission_request', 'elicitation_request', 'token_usage', 'progress', 'completed']) {
    const result = await exercise([{ type, text: 'work' }, { type: 'failed', error }]);
    assert.equal(result.calls.length, 1, type);
    assert.equal(result.persisted.length, 0, type);
  }
});
test('no retry for other provider, missing/same default, resolution failure or unrelated failure', async () => {
  for (const options of [{ request: { modelProvider: 'claude' } }, { defaultModel: null }, { defaultModel: 'gpt-5.5' }, { request: { model: 'configured-good' } }, { resolveThrows: true }]) {
    assert.equal((await exercise([{ type: 'failed', error }], options)).calls.length, 1);
  }
  assert.equal((await exercise([{ type: 'failed', error: 'network unavailable' }])).calls.length, 1);
});
test('pre-execution thrown rejection can recover; successful run unchanged', async () => {
  assert.equal((await exercise([], { throws: true })).calls.length, 2);
  const result = await exercise([{ type: 'completed', finalMessage: 'ok' }]);
  assert.equal(result.calls.length, 1);
  assert.equal(result.persisted.length, 0);
});

test('app-server emits a work marker even for reasoning, unknown items and streaming text', async () => {
  const { CodexAppServerBackend } = await import('../dist/codexAppServer.js');
  const backend = new CodexAppServerBackend({});
  for (const type of ['reasoning', 'agentMessage', 'futureTool']) assert.deepEqual(backend.mapItemStarted({ type }), { type: 'work_started' });
  assert.deepEqual(backend.mapNotification({ method: 'item/agentMessage/delta', params: {} }, null, null), { type: 'work_started' });
});
