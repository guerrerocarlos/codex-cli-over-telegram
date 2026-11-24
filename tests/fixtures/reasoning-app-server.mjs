#!/usr/bin/env node
import readline from 'node:readline';

const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let turns = 0;
let initializes = 0;
let resumes = 0;
let starts = 0;
let interrupts = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  let result = {};
  if (method === 'initialize') initializes++;
  if (method === 'thread/start') starts++;
  if (method === 'thread/resume') resumes++;
  if (method === 'config/read') result = { config: { model_reasoning_effort: 'medium' } };
  if (method === 'thread/start' || method === 'thread/resume') result = { thread: { id: 'thread-test' } };
  if (method === 'turn/start') {
    turns++;
    result = { turn: { id: `turn-${turns}` } };
  }
  send({ id, result });
  if (method === 'thread/compact/start') {
    send({ method: 'thread/compacted', params: { threadId: 'thread-test' } });
  }
  if (method === 'turn/interrupt') {
    interrupts++;
    send({ method: 'turn/completed', params: { threadId: 'thread-test',
      turn: { id: params.turnId, status: 'interrupted' } } });
  }
  if (method === 'turn/start') {
    const prompt = params.input[0].text;
    if (prompt === 'crash') { process.exit(1); }
    if (prompt === 'hold') return;
    const autonomous = () => send({ method: 'turn/started', params: { threadId: 'thread-test',
      turn: { id: 'unmanaged-turn', status: 'inProgress' } } });
    if (prompt === 'parallel') autonomous();
    if (prompt === 'autonomous') setTimeout(autonomous, 50);
    setTimeout(() => {
      send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: 'stale-turn', status: 'failed' } } });
      send({ method: 'item/completed', params: { threadId: 'thread-test', turnId: `turn-${turns}`,
        item: { type: 'agentMessage', text: JSON.stringify({ effort: params.effort, args: process.argv.slice(2),
          pid: process.pid, turns, initializes, resumes, starts, interrupts }) } } });
      send({ method: 'turn/completed', params: { threadId: 'thread-test', turn: { id: `turn-${turns}`, status: 'completed' } } });
    }, 10);
  }
});
