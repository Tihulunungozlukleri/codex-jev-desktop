import test from 'node:test';
import assert from 'node:assert/strict';
import { askJev } from '../src/jev.mjs';

const options = { url: 'https://api.typesafe.ai/v1/systemone', key: 'test-key', timeoutMs: 25 };

test('JEV HTTP failures remain classified for the relay fallback', async () => {
  for (const status of [401, 402, 429, 500]) {
    const result = await askJev({}, { ...options, fetchImpl: async () => new Response('', { status }) });
    assert.equal(result.error, `jev_http_${status}`);
  }
  const malformed = await askJev({}, { ...options, fetchImpl: async () => new Response('{bad json', { status: 200 }) });
  assert.equal(malformed.error, 'jev_invalid_response');
});

test('JEV DNS failure and timeout return fallback reasons without throwing', async () => {
  const unavailable = await askJev({}, { ...options, fetchImpl: async () => { throw new TypeError('DNS failed'); } });
  assert.equal(unavailable.error, 'jev_unavailable');
  const timedOut = await askJev({}, { ...options, fetchImpl: async (_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }) });
  assert.equal(timedOut.error, 'jev_timeout');
});
