import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCatalog, chooseProfile, addAutoModel, catalogRequestContext } from '../src/catalog.mjs';
import { requestInfo, dossier, redact } from '../src/context.mjs';
import { normalizeDecision, applyCacheTieBreak, applyPhaseLease } from '../src/policy.mjs';
import { usageFromSse, SseObserver } from '../src/usage.mjs';
import { parseManualPreference, resolveManualPreference } from '../src/manual.mjs';
import { startServer } from '../src/server.mjs';
import { latestFailureAttempt } from '../src/rescue-policy.mjs';

const models = { models: [
  { slug: 'gpt-6-luna', supported_reasoning_levels: ['low','medium'], visibility: 'list' },
  { slug: 'gpt-6-sol', supported_reasoning_levels: ['low','medium','high','xhigh'], visibility: 'list' },
  { slug: 'gpt-6-astra', supported_reasoning_levels: ['low','medium','high','xhigh'], visibility: 'list' },
] };
const answers = {
  model_class: { choice: 'fast', confidence: 0.95 }, effort: { choice: 'low', confidence: 0.95 },
  task_mode: { choice: 'execute', confidence: 0.95 }, team: { choice: 'explorer', confidence: 0.9 },
  risk: { choice: 'low', confidence: 0.9 }, lease: { choice: 'user_turn', confidence: 0.9 },
};

test('catalog rejects unknown profiles and clamps effort to supported pair', () => {
  const catalog = normalizeCatalog(models);
  assert.equal(catalog.length, 3);
  assert.deepEqual(chooseProfile(catalog, 'fast', 'xhigh'), { model: 'gpt-6-luna', effort: 'medium' });
  assert.equal(chooseProfile([], 'fast', 'low'), null);
});

test('Jev Auto advertises only its four supported effort choices', () => {
  const payload = { models: [{ slug: 'gpt-6-sol', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default_reasoning_level: 'ultra' }] };
  const auto = addAutoModel(payload).models[0];
  assert.deepEqual(auto.supported_reasoning_levels, ['low', 'medium', 'high', 'xhigh']);
  assert.equal(auto.default_reasoning_level, 'medium');
  assert.equal(payload.models[0].supported_reasoning_levels.length, 6);
});

test('catalog cache keys separate client versions and authenticated accounts', () => {
  const desktop = catalogRequestContext({ 'user-agent': 'codex_desktop/0.155.0-alpha.16.4 (Windows)', 'chatgpt-account-id': 'account-a' });
  assert.equal(desktop.path, '/models?client_version=0.155.0');
  const cli = catalogRequestContext({ 'user-agent': 'codex_cli_rs/0.150.0', 'chatgpt-account-id': 'account-a' });
  assert.notEqual(desktop.key, cli.key);
  const other = catalogRequestContext({ 'user-agent': 'codex_desktop/0.155.0', 'chatgpt-account-id': 'account-b' });
  assert.notEqual(desktop.key, other.key);
});

test('short follow-up keeps active task, while secrets are removed only from dossier', () => {
  const info = { current: 'düzelt', prior: null };
  const state = dossier(info, { activeTask: 'Fix auth race with Bearer abcdefghijklmnop' });
  assert.match(state.active_task, /Fix auth race/);
  assert.doesNotMatch(state.active_task, /abcdefghijklmnop/);
  const original = 'Authorization: Bearer abcdefghijklmnop';
  assert.equal(original.includes('abcdefghijklmnop'), true);
  assert.doesNotMatch(redact(original), /abcdefghijklmnop/);
});

test('risk and low confidence prevent weak route', () => {
  const catalog = normalizeCatalog(models);
  const highRisk = normalizeDecision({ ...answers, risk: { choice: 'high', confidence: .9 } }, catalog);
  assert.equal(highRisk.model_class, 'standard');
  assert.equal(highRisk.effort, 'high');
  assert.equal(highRisk.task_mode, 'inspect_first');
  assert.equal(highRisk.subagent_count, 1);
  const uncertain = normalizeDecision({ ...answers, model_class: { choice: 'fast', confidence: .2 } }, catalog);
  assert.equal(uncertain.model_class, 'strongest');
  assert.equal(uncertain.route.model, 'gpt-6-astra');
});

test('cache only breaks a close downshift; usage is observed from native SSE', () => {
  const catalog = normalizeCatalog(models);
  const decision = normalizeDecision({ ...answers, model_class: { choice: 'fast', confidence: .9 } }, catalog);
  const current = { model: 'gpt-6-sol', effort: 'high' };
  const tied = applyCacheTieBreak(decision, current, catalog, { model: current.model, cachedTokens: 12000, at: Date.now() });
  assert.deepEqual(tied.route, current);
  const hard = { ...decision, model_class: 'strongest', route: { model: 'gpt-6-astra', effort: 'high' } };
  assert.deepEqual(applyCacheTieBreak(hard, current, catalog, { model: current.model, cachedTokens: 12000, at: Date.now() }).route, hard.route);
  assert.equal(usageFromSse('event: response.completed\ndata: {"response":{"usage":{"input_tokens":15000,"input_tokens_details":{"cached_tokens":12000}}}}\n\n').cachedTokens, 12000);
});

test('phase lease keeps the current route for a short follow-up downshift', () => {
  const catalog = normalizeCatalog(models);
  const current = { model: 'gpt-6-sol', effort: 'high' };
  const decision = { route: { model: 'gpt-6-luna', effort: 'low' }, risk: 'low', source: 'jev' };
  assert.deepEqual(applyPhaseLease(decision, current, catalog, 'phase', true).route, current);
  assert.equal(applyPhaseLease(decision, current, catalog, 'user_turn', true).route.model, 'gpt-6-luna');
});

test('SSE observer captures visible text and cache usage across chunk boundaries', () => {
  const observer = new SseObserver();
  const frames = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Merhaba"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":9000,"input_tokens_details":{"cached_tokens":8000}}}}\n\n';
  const bytes = Buffer.from(frames);
  for (let i = 0; i < bytes.length; i += 7) observer.push(bytes.subarray(i, i+7));
  observer.finish();
  assert.equal(observer.visible, 'Merhaba');
  assert.equal(observer.usage.cachedTokens, 8000);
});

test('recognizes fresh turn and tool continuation', () => {
  const fresh = requestInfo({ input: [{ type: 'additional_tools' }, { role: 'user', content: [{ type: 'input_text', text: 'Fix bug' }] }] }, { 'thread-id': 't1' });
  assert.equal(fresh.fresh, true);
  assert.ok(fresh.key);
  const continuation = requestInfo({ input: [{ type: 'additional_tools' }, { type: 'function_call_output', output: 'ok' }] }, { 'thread-id': 't1' });
  assert.equal(continuation.continuation, true);
  assert.equal(continuation.fresh, false);
});

test('explicit Turkish and English route requests outrank JEV', () => {
  const catalog = normalizeCatalog(models);
  assert.deepEqual(resolveManualPreference(parseManualPreference('bu turu Astra ile yap'), catalog, { model: 'gpt-6-sol', effort: 'medium' }).route,
    { model: 'gpt-6-astra', effort: 'medium' });
  assert.deepEqual(resolveManualPreference(parseManualPreference('use Sol high'), catalog, null).route,
    { model: 'gpt-6-sol', effort: 'high' });
  assert.equal(parseManualPreference("JEV'i bu tur atla").bypass, true);
  assert.equal(parseManualPreference('Astra nedir?'), null);
  assert.equal(parseManualPreference('Bu turda Astra ile derinden incele')?.model, 'astra');
  assert.deepEqual(parseManualPreference('Bu turda Astra’yı kullan; projeyi derinden incele.'), { model: 'astra', effort: null });
  assert.deepEqual(parseManualPreference('Bu turda Sol high kullan.'), { model: 'sol', effort: 'high' });
  assert.equal(parseManualPreference('Astra’yı kullanma.'), null);
});

test('one-turn model request fixes Astra while JEV chooses effort from the task and continuations keep that route', async t => {
  const asked = [];
  const f = await fixture(t, 'active', request => {
    asked.push(request);
    return { answers: { ...answers,
      model_class: { choice: 'fast', confidence: .99 },
      effort: { choice: request.state.current_user_request.toLowerCase().includes('mimari') ? 'xhigh' : 'low', confidence: .99 },
    } };
  });
  await f.store.setControl({ astraRescueOnly: true, override: { model: 'gpt-6-sol', effort: 'high' } });
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'one-turn-astra', 'content-type': 'application/json' };
  const send = async body => {
    const response = await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.text();
    const upstream = f.calls.filter(item => item.url.endsWith('/responses')).at(-1);
    return JSON.parse(upstream.options.body.toString());
  };
  const special = { ...turn, input: [{ type: 'additional_tools' }, { role: 'user', content: 'Bu turda Astra’yı kullan şimdi mimariyi derinden incele.' }] };
  let forwarded = await send(special);
  assert.equal(forwarded.model, 'gpt-6-astra');
  assert.equal(forwarded.reasoning.effort, 'xhigh');
  assert.match(forwarded.instructions, /JEV route: gpt-6-astra · xhigh/);
  assert.equal(asked.length, 1);
  assert.equal(f.store.lastDecision.source, 'jev_prompt_model');
  forwarded = await send({ model: 'jev-auto', input: [{ type: 'function_call_output', call_id: 'failure', output: 'FAIL test: AssertionError' }] });
  assert.equal(forwarded.model, 'gpt-6-astra');
  assert.equal(forwarded.reasoning.effort, 'xhigh');
  assert.equal(asked.length, 1);
  await f.store.setControl({ override: null });
  forwarded = await send({ ...turn, input: [{ type: 'additional_tools' }, { role: 'user', content: 'README içindeki yazım hatasını düzelt.' }] });
  assert.equal(forwarded.model, 'gpt-6-luna');
  assert.equal(forwarded.reasoning.effort, 'low');
});

test('explicit model plus effort remains fixed, and model-only request falls back to high if JEV is unavailable', async t => {
  const f = await fixture(t, 'active', { malformed: true });
  await f.store.setControl({ astraRescueOnly: true });
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'astra-fallback', 'content-type': 'application/json' };
  const send = async text => {
    const body = { ...turn, input: [{ type: 'additional_tools' }, { role: 'user', content: text }] };
    const response = await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200); await response.text();
    return JSON.parse(f.calls.filter(item => item.url.endsWith('/responses')).at(-1).options.body.toString());
  };
  let forwarded = await send('Bu turda astrayı kullan. Derin inceleme yap.');
  assert.equal(forwarded.model, 'gpt-6-astra');
  assert.equal(forwarded.reasoning.effort, 'high');
  forwarded = await send('Use Astra low for this turn.');
  assert.equal(forwarded.model, 'gpt-6-astra');
  assert.equal(forwarded.reasoning.effort, 'low');
});

test('hook guidance and actual route agree on an explicit one-turn Astra request', async t => {
  const f = await fixture(t, 'active', { answers: { ...answers,
    model_class: { choice: 'fast', confidence: .99 }, effort: { choice: 'medium', confidence: .99 } } });
  await f.store.setControl({ astraRescueOnly: true });
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'preflight-astra', 'content-type': 'application/json' };
  // Fill the session catalog before the hook runs, as in an established task.
  const warm = await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(turn) });
  await warm.text();
  const prompt = 'Bu turda Astra ile derinden incele.';
  const preflight = await fetch(`${f.base}/preflight`, { method: 'POST', headers,
    body: JSON.stringify({ session_id: 'preflight-astra', prompt }) });
  assert.equal(preflight.status, 200);
  const advice = await preflight.json();
  assert.equal(advice.decision.route.model, 'gpt-6-astra');
  assert.equal(advice.decision.route.effort, 'medium');
  assert.match(advice.guidance, /Explicit one-turn Astra request/);
  const routed = await fetch(`${f.base}/responses`, { method: 'POST', headers,
    body: JSON.stringify({ ...turn, input: [{ type: 'additional_tools' }, { role: 'user', content: prompt }] }) });
  assert.equal(routed.status, 200); await routed.text();
  const upstream = JSON.parse(f.calls.filter(item => item.url.endsWith('/responses')).at(-1).options.body.toString());
  assert.equal(upstream.model, 'gpt-6-astra');
  assert.equal(upstream.reasoning.effort, 'medium');
});

async function fixture(t, mode = 'active', jevResult = { answers }, catalogForUrl = () => models, responseForUrl = null) {
  const dataDir = await mkdtemp(join(tmpdir(), 'jev-desktop-test-'));
  const calls = [];
  const config = { host: '127.0.0.1', port: 0, timeoutMs: 200, upstreamChatgpt: 'https://chatgpt.com/backend-api/codex',
    upstreamApi: 'https://api.openai.com/v1', jevUrl: 'https://api.typesafe.ai/v1/systemone', jevKey: 'typesafe-secret', dataDir,
    mode, capabilityToken: 'local-secret', maxRequestBytes: 1000000 };
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('typesafe.ai')) return new Response(JSON.stringify(typeof jevResult === 'function' ? jevResult(JSON.parse(options.body)) : jevResult), { status: 200, headers: { 'content-type': 'application/json' } });
    if (new URL(url).pathname.endsWith('/models')) {
      const selected = catalogForUrl(new URL(url));
      return selected instanceof Response ? selected : new Response(JSON.stringify(selected), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return responseForUrl?.(new URL(url), options) ?? new Response('event: response.completed\ndata: {"ok":true}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const runtime = await startServer(config, { fetchImpl: fakeFetch });
  t.after(async () => { await new Promise(resolve => runtime.server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${runtime.address.port}`;
  const localHeaders = { 'x-jev-desktop-token': 'local-secret' };
  return { ...runtime, config, calls, base, localHeaders };
}

test('without an installed capability token only health and admin with its token are reachable', async t => {
  const f = await fixture(t);
  f.config.capabilityToken = null;
  for (const [path, method] of [['/models', 'GET'], ['/responses', 'POST'], ['/preflight', 'POST']]) {
    const response = await fetch(`${f.base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 403, path);
  }
  assert.equal((await fetch(`${f.base}/health`)).status, 200);
  assert.equal((await fetch(`${f.base}/admin/report`)).status, 403);
  assert.equal((await fetch(`${f.base}/admin/report`, { headers: { 'x-jev-admin-token': f.config.adminToken } })).status, 200);
  assert.equal(f.calls.length, 0);
});

test('catalog refresh uses bounded stale data for transient failures but not auth failures', async t => {
  let now = 1000000, status = 200;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, 'active', { answers }, () => status === 200 ? models : new Response('', { status }));
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'catalog-fallback', 'content-type': 'application/json' };
  const send = () => fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(turn) });
  assert.equal((await send()).status, 200);
  now += 300001; status = 503;
  assert.equal((await send()).status, 200);
  now += 300001; status = 429;
  assert.equal((await send()).status, 200);
  status = 401;
  assert.equal((await send()).status, 503);
  now += 300000; status = 503;
  assert.equal((await send()).status, 503);
  assert.equal(f.calls.filter(item => new URL(item.url).pathname.endsWith('/models')).length, 5);
});

test('closing a streaming client cancels the upstream stream', async t => {
  let canceled;
  const canceledPromise = new Promise(resolve => { canceled = resolve; });
  const f = await fixture(t, 'active', { answers }, () => models, () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"delta":"hello"}\n\n')); },
    cancel() { canceled(); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const abort = new AbortController();
  const response = await fetch(`${f.base}/responses`, { method: 'POST', signal: abort.signal,
    headers: { ...f.localHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-sol', input: [] }) });
  await response.body.getReader().read();
  abort.abort();
  await Promise.race([canceledPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('upstream stream was not canceled')), 1000))]);
});

const turn = { model: 'jev-auto', reasoning: { effort: 'medium' }, input: [
  { type: 'additional_tools' }, { role: 'user', content: [{ type: 'input_text', text: 'Fix README typo' }] },
] };

test('Astra rescue requires two distinct standard/high failures, stays for the rescue, and resets next turn', async t => {
  const strongest = { ...answers, model_class: { choice: 'strongest', confidence: .99 }, effort: { choice: 'high', confidence: .99 } };
  const f = await fixture(t, 'active', { answers: strongest });
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'rescue-test', 'content-type': 'application/json' };
  const enabled = await fetch(`${f.base}/admin/control`, { method: 'POST', headers: { ...headers, 'x-jev-admin-token': f.config.adminToken }, body: JSON.stringify({ astraRescueOnly: true }) });
  assert.equal(enabled.status, 200);
  assert.equal(JSON.parse(await readFile(join(f.config.dataDir, 'control'), 'utf8')).astraRescueOnly, true);
  const onlyAstra = await fetch(`${f.base}/admin/model-policy`, { method: 'POST', headers: { ...headers, 'x-jev-admin-token': f.config.adminToken }, body: JSON.stringify({ operation: 'only', models: ['gpt-6-astra'] }) });
  assert.equal(onlyAstra.status, 400);
  const send = async body => { const response = await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200); await response.text(); return JSON.parse(f.calls.filter(call => call.url.endsWith('/responses')).at(-1).options.body.toString()).model; };
  const fail = id => ({ model: 'jev-auto', input: [{ type: 'function_call_output', call_id: id, output: 'FAIL test: AssertionError' }] });
  await f.store.setControl({ override: { model: 'gpt-6-astra', effort: 'high' } });
  assert.equal(await send(turn), 'gpt-6-sol');
  assert.equal(await send(fail('attempt-1')), 'gpt-6-sol');
  assert.equal(await send(fail('attempt-1')), 'gpt-6-sol');
  assert.equal(await send(fail('attempt-2')), 'gpt-6-astra');
  assert.equal(await send({ model: 'jev-auto', input: [{ type: 'function_call_output', call_id: 'success', output: 'test passed' }] }), 'gpt-6-astra');
  assert.equal(await send(turn), 'gpt-6-sol');
  assert.equal(await send(fail('attempt-3')), 'gpt-6-sol');
});

test('uncertainty, JEV outages and excluded models cannot bypass Astra rescue policy', async t => {
  let result = { answers: { ...answers, model_class: { choice: 'strongest', confidence: .99 }, effort: { choice: 'high', confidence: .99 } } };
  const f = await fixture(t, 'active', () => result);
  await f.store.setControl({ astraRescueOnly: true });
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'uncertain-rescue', 'content-type': 'application/json' };
  const send = async body => { const response = await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200); await response.text(); return JSON.parse(f.calls.filter(call => call.url.endsWith('/responses')).at(-1).options.body.toString()).model; };
  const fail = id => ({ model: 'jev-auto', input: [{ type: 'function_call_output', call_id: id, output: 'FAIL assertion' }] });
  await send(turn);
  assert.equal(await send(fail('one')), 'gpt-6-sol');
  result = { answers: { ...answers, model_class: { choice: 'strongest', confidence: .2 } } };
  assert.equal(await send(fail('two')), 'gpt-6-sol');
  result = { malformed: true };
  assert.equal(await send(fail('three')), 'gpt-6-sol');
  await f.store.setControl({ modelPolicy: { deny: ['gpt-6-astra'] } });
  result = { answers: { ...answers, model_class: { choice: 'strongest', confidence: .99 }, effort: { choice: 'high', confidence: .99 } } };
  assert.equal(await send(fail('four')), 'gpt-6-sol');
});

test('rescue evidence ignores historical failures, successful commands and infrastructure errors', () => {
  const output = (call_id, text) => ({ type: 'function_call_output', call_id, output: text });
  assert.equal(latestFailureAttempt({ input: [output('old', 'FAIL assertion'), output('new', 'passed')] }), null);
  assert.equal(latestFailureAttempt({ input: [output('one', '{"exit_code":0,"output":"file contains FAILED"}')] }), null);
  assert.equal(latestFailureAttempt({ input: [output('one', 'FAIL: network error ECONNREFUSED')] }), null);
  assert.equal(latestFailureAttempt({ input: [output('one', 'FAIL: permission denied')] }), null);
  assert.ok(latestFailureAttempt({ input: [output('one', '{"exit_code":1,"output":"assertion mismatch"}')] }));
  assert.notEqual(latestFailureAttempt({ input: [output('one', 'FAIL assertion')] }), latestFailureAttempt({ input: [output('two', 'FAIL assertion')] }));
});

test('model pool persists and prevents excluded routes in manual overrides, fallback, continuation and subagent advice', async t => {
  const f = await fixture(t);
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 'pool-test', 'content-type': 'application/json' };
  const send = async body => { const response = await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(body) }); assert.equal(response.status, 200); await response.text(); };
  await send(turn);
  const adminHeaders = { ...f.localHeaders, 'x-jev-admin-token': f.config.adminToken, 'content-type': 'application/json' };
  const change = (operation, models) => fetch(`${f.base}/admin/model-policy`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ operation, models }) });
  assert.equal((await fetch(`${f.base}/admin/model-policy`, { method: 'POST', headers: f.localHeaders, body: JSON.stringify({ operation: 'reset' }) })).status, 403);
  assert.equal((await change('only', ['gpt-6-sol'])).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(f.config.dataDir, 'control'), 'utf8')).modelPolicy, { allow: ['gpt-6-sol'], deny: [] });
  assert.equal((await change('disable', ['gpt-6-sol'])).status, 400);
  assert.equal((await change('enable', ['gpt-99-fake'])).status, 400);
  await f.store.setControl({ override: { model: 'gpt-6-luna', effort: 'low' } });
  await send({ ...turn, input: [{ role: 'user', content: 'use Luna low' }] });
  await f.store.setControl({ disabled: true });
  await send({ ...turn, input: [...turn.input, { type: 'function_call_output', call_id: 'x', output: 'done' }] });
  const preflight = await fetch(`${f.base}/preflight`, { method: 'POST', headers, body: JSON.stringify({ session_id: 'pool-test', prompt: 'continue' }) });
  assert.equal((await preflight.json()).decision.route.model, 'gpt-6-sol');
  await f.store.setControl({ disabled: false, override: null });
  const advice = await fetch(`${f.base}/preflight`, { method: 'POST', headers, body: JSON.stringify({ session_id: 'pool-test', prompt: 'check the files' }) });
  assert.equal((await advice.json()).decision.subagents[0].route.model, 'gpt-6-sol');
  const routed = f.calls.filter(call => call.url.endsWith('/responses')).map(call => JSON.parse(call.options.body.toString()).model);
  assert.deepEqual(routed, ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-sol']);
  assert.equal((await change('enable', ['gpt-6-luna'])).status, 200);
  await send(turn);
  assert.equal(JSON.parse(f.calls.filter(call => call.url.endsWith('/responses')).at(-1).options.body.toString()).model, 'gpt-6-luna');
  assert.equal((await change('disable', ['gpt-6-luna'])).status, 200);
  await send(turn);
  assert.equal(JSON.parse(f.calls.filter(call => call.url.endsWith('/responses')).at(-1).options.body.toString()).model, 'gpt-6-sol');
  assert.equal((await change('reset', [])).status, 200);
});

test('older CLI model listing cannot replace the Desktop routing catalog', async t => {
  const older = { models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'] }] };
  const f = await fixture(t, 'active', { answers }, url => url.searchParams.get('client_version') === '0.155.0' ? models : older);
  const common = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'content-type': 'application/json' };
  const desktop = { ...common, 'user-agent': 'codex_desktop/0.155.0-alpha.16.4', 'thread-id': 'desktop-thread' };
  await fetch(`${f.base}/responses`, { method: 'POST', headers: desktop, body: JSON.stringify(turn) });
  const cli = await fetch(`${f.base}/models?client_version=0.150.0`, { headers: { ...common, 'user-agent': 'codex_cli_rs/0.150.0' } });
  assert.equal((await cli.json()).models.some(item => item.slug === 'gpt-6-astra'), false);
  await fetch(`${f.base}/responses`, { method: 'POST', headers: desktop, body: JSON.stringify(turn) });
  const forwarded = f.calls.filter(call => call.url.endsWith('/responses')).map(call => JSON.parse(call.options.body.toString()).model);
  assert.deepEqual(forwarded, ['gpt-6-luna', 'gpt-6-luna']);
  assert.equal(f.calls.filter(call => new URL(call.url).searchParams.get('client_version') === '0.155.0').length, 1);
});

test('active route chooses exact pair and preserves canonical input and SSE', async t => {
  const f = await fixture(t);
  const catalog = await fetch(`${f.base}/models`, { headers: { ...f.localHeaders, authorization: 'Bearer codex-secret', 'chatgpt-account-id': 'account' } });
  assert.equal((await catalog.json()).models[0].slug, 'jev-auto');
  const routedTurn = { ...turn, instructions: 'Preserve this original instruction.' };
  const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders, authorization: 'Bearer codex-secret', 'chatgpt-account-id': 'account', 'thread-id': 't1', 'content-type': 'application/json' }, body: JSON.stringify(routedTurn) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'event: response.completed\ndata: {"ok":true}\n\n');
  const jevCall = f.calls.find(x => x.url.includes('typesafe.ai'));
  const upstream = f.calls.find(x => x.url.endsWith('/responses'));
  assert.ok(jevCall);
  assert.doesNotMatch(JSON.stringify(jevCall), /codex-secret/);
  assert.equal(upstream.options.headers.authorization, 'Bearer codex-secret');
  assert.doesNotMatch(JSON.stringify(upstream), /typesafe-secret/);
  const forwarded = JSON.parse(upstream.options.body.toString());
  assert.equal(forwarded.model, 'gpt-6-luna');
  assert.equal(forwarded.reasoning.effort, 'low');
  assert.deepEqual(forwarded.input, turn.input);
  assert.match(forwarded.instructions, /^Preserve this original instruction\./);
  assert.match(forwarded.instructions, /JEV route: gpt-6-luna · low/);
  assert.equal(f.address.address, '127.0.0.1');
  const decisionLog = await readFile(join(f.config.dataDir, 'decisions.jsonl'), 'utf8');
  assert.doesNotMatch(decisionLog, /Fix README typo|codex-secret|typesafe-secret/);
});

test('route footer can be disabled without changing model routing', async t => {
  const f = await fixture(t);
  await f.store.setControl({ footer: false });
  const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders,
    'chatgpt-account-id': 'account', 'thread-id': 'no-footer', 'content-type': 'application/json' }, body: JSON.stringify(turn) });
  assert.equal(response.status, 200);
  const upstream = f.calls.find(x => x.url.endsWith('/responses'));
  const forwarded = JSON.parse(upstream.options.body.toString());
  assert.equal(forwarded.model, 'gpt-6-luna');
  assert.equal(forwarded.instructions, undefined);
});

test('admin actions require the separate admin token and never forward local tokens', async t => {
  const f = await fixture(t);
  const controlUrl = `${f.base}/admin/control`;
  const request = headers => fetch(controlUrl, { method: 'POST', headers: { ...f.localHeaders, ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'shadow' }) });
  assert.equal((await request({})).status, 403);
  assert.equal((await request({ 'x-jev-admin-token': 'wrong' })).status, 403);
  assert.equal((await request({ 'x-jev-admin-token': f.config.adminToken, origin: 'https://evil.example' })).status, 403);
  const accepted = await request({ 'x-jev-admin-token': f.config.adminToken });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).mode, 'shadow');
  await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders,
    'x-jev-admin-token': f.config.adminToken, 'chatgpt-account-id': 'account', 'thread-id': 'token-thread',
    'content-type': 'application/json' }, body: JSON.stringify(turn) });
  const upstream = f.calls.find(x => x.url.endsWith('/responses'));
  assert.equal(upstream.options.headers['x-jev-admin-token'], undefined);
  assert.equal(upstream.options.headers['x-jev-desktop-token'], undefined);
});

test('calibration records outcome without archiving the prompt in metrics', async t => {
  const f = await fixture(t);
  await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders,
    'chatgpt-account-id': 'account', 'thread-id': 'calibration-thread', 'content-type': 'application/json' }, body: JSON.stringify(turn) });
  const url = `${f.base}/admin/calibrate`;
  const label = { taskType: 'small_edit', outcome: 'success', retries: 1, elapsedMs: 1200, manualEscalation: false };
  const missingToken = await fetch(url, { method: 'POST', headers: { ...f.localHeaders, 'content-type': 'application/json' }, body: JSON.stringify(label) });
  assert.equal(missingToken.status, 403);
  const headers = { ...f.localHeaders, 'x-jev-admin-token': f.config.adminToken, 'content-type': 'application/json' };
  const invalid = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ ...label, taskType: 'arbitrary' }) });
  assert.equal(invalid.status, 400);
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(label) });
  assert.equal(accepted.status, 200);
  const saved = await accepted.json();
  assert.equal(saved.model, 'gpt-6-luna');
  assert.equal(saved.retries, 1);
  const report = await f.store.report();
  assert.deepEqual(report.calibration.byTaskType.small_edit, { total: 1, success: 1, failure: 0, retries: 1, manualEscalations: 0 });
  assert.equal(report.calibration.byTaskTypeRoute['small_edit:gpt-6-luna/low'].success, 1);
  assert.equal(report.estimates.quotaSavings, null);
  const archive = await readFile(join(f.config.dataDir, 'calibration.jsonl'), 'utf8');
  assert.doesNotMatch(archive, /Fix README typo|typesafe-secret/);
});

test('preflight decisions are isolated by Codex session for identical follow-ups', async t => {
  const f = await fixture(t, 'active', request => ({ answers: {
    ...answers, model_class: { choice: request.state.active_task.includes('complex') ? 'strongest' : 'fast', confidence: .99 },
  } }));
  const keyA = requestInfo({}, { 'thread-id': 'session-a' }).key;
  const keyB = requestInfo({}, { 'thread-id': 'session-b' }).key;
  await f.store.updateSession(keyA, { activeTask: 'complex architecture investigation' });
  await f.store.updateSession(keyB, { activeTask: 'simple typo' });
  for (const session of ['session-a', 'session-b']) {
    const response = await fetch(`${f.base}/preflight`, { method: 'POST', headers: { ...f.localHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: session, prompt: 'düzelt' }) });
    assert.equal(response.status, 200);
  }
  const followup = { ...turn, input: [turn.input[0], { role: 'user', content: [{ type: 'input_text', text: 'düzelt' }] }] };
  for (const session of ['session-a', 'session-b']) {
    const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders,
      'chatgpt-account-id': 'account', 'thread-id': session, 'content-type': 'application/json' }, body: JSON.stringify(followup) });
    assert.equal(response.status, 200);
  }
  const forwarded = f.calls.filter(x => x.url.endsWith('/responses')).map(x => JSON.parse(x.options.body.toString()).model);
  assert.deepEqual(forwarded, ['gpt-6-astra', 'gpt-6-luna']);
  assert.equal(f.calls.filter(x => x.url.includes('typesafe.ai')).length, 2);
});

test('shadow and JEV failure use catalog baseline while preserving input', async t => {
  const f = await fixture(t, 'shadow', { malformed: true });
  const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 't2', 'content-type': 'application/json' }, body: JSON.stringify(turn) });
  assert.equal(response.status, 200);
  const upstream = f.calls.find(x => x.url.endsWith('/responses'));
  const forwarded = JSON.parse(upstream.options.body.toString());
  assert.equal(forwarded.model, 'gpt-6-sol');
  assert.deepEqual(forwarded.input, turn.input);
  assert.equal(f.store.lastDecision.shadow, true);
  assert.equal(f.store.lastDecision.source, 'jev_invalid_response');
});

test('manual model bypasses JEV and browser-origin requests are rejected', async t => {
  const f = await fixture(t);
  const manual = { ...turn, model: 'gpt-6-sol' };
  const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders, 'content-type': 'application/json' }, body: JSON.stringify(manual) });
  assert.equal(response.status, 200);
  assert.equal(f.calls.filter(x => x.url.includes('typesafe.ai')).length, 0);
  const forbidden = await fetch(`${f.base}/health`, { headers: { ...f.localHeaders, origin: 'https://evil.example' } });
  assert.equal(forbidden.status, 403);
});

test('global bypass does not call JEV', async t => {
  const f = await fixture(t, 'active');
  await f.store.setControl({ disabled: true });
  const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders,
    'chatgpt-account-id': 'account', 'thread-id': 'bypass-thread', 'content-type': 'application/json' }, body: JSON.stringify(turn) });
  assert.equal(response.status, 200);
  assert.equal(f.calls.filter(x => x.url.includes('typesafe.ai')).length, 0);
  assert.equal(f.store.lastDecision.source, 'bypass');
});

test('shadow observes a native model without changing its request', async t => {
  const f = await fixture(t, 'shadow');
  const native = { ...turn, model: 'gpt-6-sol' };
  const response = await fetch(`${f.base}/responses`, { method: 'POST', headers: { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 't3', 'content-type': 'application/json' }, body: JSON.stringify(native) });
  assert.equal(response.status, 200);
  const upstream = f.calls.find(x => x.url.endsWith('/responses'));
  assert.deepEqual(JSON.parse(upstream.options.body.toString()), native);
  assert.equal(f.store.lastDecision.model, 'gpt-6-luna');
  assert.equal(f.store.lastDecision.actual_model, 'gpt-6-sol');
  assert.equal(f.store.lastDecision.shadow, true);
});

test('tool loop keeps route and consults JEV once for a new test failure', async t => {
  const f = await fixture(t, 'active');
  const headers = { ...f.localHeaders, 'chatgpt-account-id': 'account', 'thread-id': 't4', 'content-type': 'application/json' };
  await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(turn) });
  const before = f.calls.filter(x => x.url.includes('typesafe.ai')).length;
  const continuation = { model: 'jev-auto', input: [{ type: 'function_call_output', output: 'test passed' }] };
  await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(continuation) });
  assert.equal(f.calls.filter(x => x.url.includes('typesafe.ai')).length, before);
  const failure = { model: 'jev-auto', input: [{ type: 'function_call_output', output: 'FAIL test: AssertionError' }] };
  await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(failure) });
  const after = f.calls.filter(x => x.url.includes('typesafe.ai')).length;
  assert.equal(after, before + 1);
  await fetch(`${f.base}/responses`, { method: 'POST', headers, body: JSON.stringify(failure) });
  assert.equal(f.calls.filter(x => x.url.includes('typesafe.ai')).length, after);
});
