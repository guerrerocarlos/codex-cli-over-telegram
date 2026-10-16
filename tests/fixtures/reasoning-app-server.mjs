#!/usr/bin/env node
import readline from 'node:readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'config/read') result = { config: { model_reasoning_effort: 'medium' } };
  if (method === 'thread/start' || method === 'thread/resume') result = { thread: { id: 'thread-test' } };
  if (method === 'turn/start') result = { turn: { id: 'turn-test' } };
  send({ id, result });
  if (method === 'turn/start') {
    setTimeout(() => {
      send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: 'turn-test',
        item: { type: 'agentMessage', text: JSON.stringify({ effort: params.effort, args: process.argv.slice(2) }) } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'turn-test', status: 'completed' } } });
    }, 10);
  }
});
