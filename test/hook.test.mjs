import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPreflight } from '../src/hook-client.mjs';

const config = { port: 4319, timeoutMs: 100, capabilityToken: 'local-token' };
const event = { session_id: 'session-1', prompt: 'continue' };

test('hook starts the owned relay task and retries after connection failure', async () => {
  let calls = 0, starts = 0;
  const response = await requestPreflight(event, config, {
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers['x-jev-desktop-token'], 'local-token');
      if (calls === 1) throw new TypeError('connection refused');
      return new Response('{}', { status: 200 });
    },
    startRelay: async () => { starts++; return true; },
  });
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(starts, 1);
});

test('hook stays fail-open when the startup task cannot run', async () => {
  const response = await requestPreflight(event, config, {
    fetchImpl: async () => { throw new TypeError('connection refused'); },
    startRelay: async () => false,
  });
  assert.equal(response, null);
});
