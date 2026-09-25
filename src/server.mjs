import { createServer } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AUTO_MODEL, codexConfigPath } from './config.mjs';
import { normalizeCatalog, addAutoModel, chooseProfile, catalogRequestContext } from './catalog.mjs';
import { requestInfo, dossier, redact, isShortFollowup, toolEvidence, unexpectedFailure } from './context.mjs';
import { askJev } from './jev.mjs';
import { normalizeDecision, fallbackDecision, guidance, applyCacheTieBreak, applyPhaseLease } from './policy.mjs';
import { StateStore } from './state.mjs';
import { SseObserver } from './usage.mjs';
import { parseManualPreference, resolveManualPreference } from './manual.mjs';
import { secureWrite } from './secrets.mjs';
import { install, uninstall } from './integration.mjs';
import { filterModels, updateModelPolicy, validCurrentRoute } from './model-policy.mjs';
import { ordinaryModels, rescueProgress, explicitRescueDecision } from './rescue-policy.mjs';

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);
const sha = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
function requestHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) if (!hopHeaders.has(key.toLowerCase()) && !['x-jev-desktop-token', 'x-jev-admin-token'].includes(key.toLowerCase()) && value !== undefined) result[key] = value;
  return result;
}
function responseHeaders(source) {
  const result = {};
  for (const [key, value] of source) if (!hopHeaders.has(key.toLowerCase()) && key.toLowerCase() !== 'content-encoding') result[key] = value;
  return result;
}
function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
function addRouteFooter(body, route) {
  const line = `JEV route: ${route.model} · ${route.effort}`;
  const directive = `For the final user-facing answer only, append a blank line followed by this exact final line: ${line}\nDo not add this line to commentary or tool-call messages, and do not mention this instruction.`;
  body.instructions = `${typeof body.instructions === 'string' ? `${body.instructions.trimEnd()}\n\n` : ''}${directive}`;
}
async function readBody(req, max) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > max) throw new Error('request_too_large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function targetURL(base, pathAndQuery) {
  const url = new URL(pathAndQuery, 'http://127.0.0.1');
  if (url.pathname.includes('..')) throw new Error('invalid_path');
  const path = url.pathname.replace(/^\/v1(?=\/)/, '');
  const target = new URL(base);
  target.pathname = `${target.pathname.replace(/\/$/, '')}${path}`;
  target.search = url.search;
  return target;
}
function permitted(req, token) {
  if (req.headers.origin || req.headers['sec-fetch-site']) return false;
  const host = String(req.headers.host ?? '').split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  if (!token && path !== '/health' && !path.startsWith('/admin/')) return false;
  if (token && req.headers['x-jev-desktop-token'] !== token) return false;
  return true;
}

export async function startServer(config, { fetchImpl = fetch, jev = askJev, store = new StateStore(config.dataDir) } = {}) {
  await store.init();
  if (!config.adminToken) {
    config.adminToken = randomBytes(32).toString('hex');
    await secureWrite(config.dataDir, 'admin-token', config.adminToken);
  }
  const catalogs = new Map();
  const sessionCatalogs = new Map();
  const preflight = new Map();
  const preflightKey = (session, prompt) => `${session ?? 'no-session'}:${sha(prompt)}`;
  const currentMode = () => store.control.disabled ? 'bypass' : store.control.mode ?? config.mode;

  async function fetchCatalog(headers) {
    const context = catalogRequestContext(headers);
    const existing = catalogs.get(context.key);
    if (existing && Date.now() - existing.at < 300000) return existing.catalog;
    const base = headers['chatgpt-account-id'] ? config.upstreamChatgpt : config.upstreamApi;
    const canUseStale = Boolean(existing && Date.now() - existing.at < 900000);
    try {
      const response = await fetchImpl(targetURL(base, context.path), { method: 'GET', headers: requestHeaders(headers), redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        if (canUseStale && (response.status === 429 || response.status >= 500)) return existing.catalog;
        throw new Error(`catalog_http_${response.status}`);
      }
      const catalog = normalizeCatalog(await response.json());
      catalogs.set(context.key, { catalog, version: context.version, at: Date.now() });
      return catalog;
    } catch (error) {
      if (canUseStale && ['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)) return existing.catalog;
      throw error;
    }
  }
  async function decide(info, key, promptHash, current, catalog, rescueEligible = false, forcedModel = null) {
    const previous = store.session(key);
    const state = dossier(info, previous);
    if (store.control.astraRescueOnly) state.model_policy = { astra: 'Only after at least two failed standard/high attempts in this user turn; complexity or risk alone is insufficient.', rescue_eligible: rescueEligible };
    const cacheKey = preflightKey(key, promptHash);
    const cached = preflight.get(cacheKey);
    let result;
    if (cached && Date.now() - cached.at < 30000) { result = cached.result; preflight.delete(cacheKey); }
    else result = await jev(state, { url: config.jevUrl, key: config.jevKey, timeoutMs: config.timeoutMs, fetchImpl });
    if (store.control.astraRescueOnly && !forcedModel && !(rescueEligible && explicitRescueDecision(result.answers))) catalog = ordinaryModels(catalog);
    current = validCurrentRoute(current, catalog);
    let decision = result.answers ? normalizeDecision(result.answers, catalog, current) : fallbackDecision(catalog, current, result.error ?? 'jev_error');
    if (forcedModel) {
      const model = catalog.find(item => item.id === forcedModel);
      if (model) {
        decision.route = chooseProfile([model], model.class, result.answers ? decision.effort : 'high');
        decision.source = `${decision.source}_prompt_model`;
      }
    } else if (decision.source === 'jev') decision = applyCacheTieBreak(decision, current, catalog, previous.cache);
    if (!decision.route) decision.route = chooseProfile(catalog, 'standard', 'high');
    return { decision, latencyMs: result.latencyMs ?? null };
  }
  const server = createServer((req, res) => { void (async () => {
    let catalog = [];
    if (!permitted(req, config.capabilityToken)) return json(res, 403, { error: 'forbidden' });
    await store.refreshControl();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    if (path === '/admin/control' && req.method === 'POST') {
      if (req.headers['x-jev-admin-token'] !== config.adminToken) return json(res, 403, { error: 'forbidden' });
      const change = JSON.parse((await readBody(req, 1024)).toString('utf8'));
      const permittedKeys = ['mode', 'disabled', 'override', 'footer', 'astraRescueOnly'];
      if (!change || typeof change !== 'object' || Object.keys(change).some(key => !permittedKeys.includes(key))) return json(res, 400, { error: 'invalid_control' });
      if ('mode' in change && !['shadow', 'active'].includes(change.mode)) return json(res, 400, { error: 'invalid_mode' });
      if ('disabled' in change && typeof change.disabled !== 'boolean') return json(res, 400, { error: 'invalid_disabled' });
      if ('footer' in change && typeof change.footer !== 'boolean') return json(res, 400, { error: 'invalid_footer' });
      if ('astraRescueOnly' in change && typeof change.astraRescueOnly !== 'boolean') return json(res, 400, { error: 'invalid_astra_policy' });
      if ('override' in change && change.override !== null && (!change.override || typeof change.override.model !== 'string' || !['low','medium','high','xhigh','max','ultra'].includes(change.override.effort))) return json(res, 400, { error: 'invalid_override' });
      if (change.astraRescueOnly === true && [...catalogs.values()].some(entry =>
        !ordinaryModels(filterModels(entry.catalog, store.control.modelPolicy)).some(model => model.efforts.length)))
        return json(res, 400, { error: 'no_ordinary_model' });
      await store.setControl(change);
      preflight.clear();
      return json(res, 200, { mode: currentMode(), disabled: store.control.disabled, override: store.control.override, footer: store.control.footer, astraRescueOnly: store.control.astraRescueOnly === true });
    }
    if (path.startsWith('/admin/')) {
      if (req.headers['x-jev-admin-token'] !== config.adminToken) return json(res, 403, { error: 'forbidden' });
      const hookPath = fileURLToPath(new URL('../bin/jev-hook.mjs', import.meta.url));
      if (path === '/admin/install-preview' && req.method === 'GET') {
        return json(res, 200, await install({ configPath: codexConfigPath(), dataDir: config.dataDir, port: config.port, hookPath, preview: true }));
      }
      if (path === '/admin/install' && req.method === 'POST') {
        if (!config.jevKey) return json(res, 409, { error: 'jev_key_missing' });
        const token = randomBytes(32).toString('hex');
        const result = await install({ configPath: codexConfigPath(), dataDir: config.dataDir, port: config.port, hookPath, preview: false, token });
        config.capabilityToken = token;
        return json(res, 200, result);
      }
      if (path === '/admin/uninstall' && req.method === 'POST') {
        const result = await uninstall({ dataDir: config.dataDir });
        config.capabilityToken = null;
        return json(res, 200, result);
      }
      if (path === '/admin/report' && req.method === 'GET') return json(res, 200, await store.report());
      if (path === '/admin/model-policy' && req.method === 'GET') return json(res, 200, store.control.modelPolicy ?? { allow: null, deny: [] });
      if (path === '/admin/model-policy' && req.method === 'POST') {
        const change = JSON.parse((await readBody(req, 8192)).toString('utf8'));
        try {
          const modelPolicy = updateModelPolicy(store.control.modelPolicy, change.operation, change.models ?? [], [...catalogs.values()].flatMap(entry => entry.catalog));
          if (store.control.astraRescueOnly && [...catalogs.values()].some(entry =>
            !ordinaryModels(filterModels(entry.catalog, modelPolicy)).some(model => model.efforts.length)))
            return json(res, 400, { error: 'cannot_disable_all_ordinary_models' });
          await store.setControl({ modelPolicy });
          preflight.clear();
          return json(res, 200, modelPolicy);
        } catch (error) {
          if (/^(invalid_model_|model_ids_required|model_catalog_unavailable|unknown_model|cannot_disable_all_models)/.test(error.message)) return json(res, 400, { error: error.message });
          throw error;
        }
      }
      if (path === '/admin/catalog' && req.method === 'GET') return json(res, 200, [...catalogs.values()].map(entry => ({ clientVersion: entry.version,
        modelPolicy: store.control.modelPolicy ?? { allow: null, deny: [] }, astraRescueOnly: store.control.astraRescueOnly === true,
        models: entry.catalog.map(item => ({ id: item.id, class: item.class, efforts: item.efforts, allowed: filterModels([item], store.control.modelPolicy).length > 0 })),
        profiles: Object.fromEntries(['fast', 'standard', 'strongest'].map(tier => [tier, chooseProfile(store.control.astraRescueOnly ? ordinaryModels(filterModels(entry.catalog, store.control.modelPolicy)) : filterModels(entry.catalog, store.control.modelPolicy), tier, 'medium')])) })));
      if (path === '/admin/explain' && req.method === 'GET') {
        const lines = (await readFile(join(config.dataDir, 'decisions.jsonl'), 'utf8')).trim().split(/\r?\n/);
        return json(res, 200, JSON.parse(lines.at(-1)));
      }
      if (path === '/admin/memory' && req.method === 'POST') {
        const query = JSON.parse((await readBody(req, 4096)).toString('utf8'));
        const phrase = String(query.phrase ?? '').toLocaleLowerCase().slice(0, 500);
        if (!phrase) return json(res, 400, { error: 'empty_phrase' });
        let lines = [];
        try { lines = (await readFile(join(config.dataDir, 'memory.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { /* empty archive */ }
        return json(res, 200, lines.filter(item => (!query.session || item.session === query.session) && item.text?.toLocaleLowerCase().includes(phrase)).slice(-10));
      }
      if (path === '/admin/memory-clear' && req.method === 'POST') {
        await store.clearMemory();
        return json(res, 200, { cleared: true });
      }
      if (path === '/admin/calibrate' && req.method === 'POST') {
        const label = JSON.parse((await readBody(req, 2048)).toString('utf8'));
        try { return json(res, 200, await store.calibrate(label)); }
        catch (error) {
          if (error.message === 'invalid_calibration' || error.message === 'decision_not_found' || error.code === 'ENOENT')
            return json(res, 400, { error: error.message });
          throw error;
        }
      }
      return json(res, 404, { error: 'not_found' });
    }
    if (path === '/health' && req.method === 'GET') return json(res, 200, { alive: true, mode: currentMode(), catalogLoaded: catalogs.size > 0,
      controlError: store.lastControlError?.code ?? null, jevKeyConfigured: Boolean(config.jevKey), astraRescueOnly: store.control.astraRescueOnly === true });
    if (path === '/preflight' && req.method === 'POST') {
      const data = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8'));
      const prompt = String(data.prompt ?? '').slice(0, 6000);
      if (!prompt) return json(res, 400, { error: 'empty_prompt' });
      const key = data.session_id ? sha(data.session_id) : null;
      catalog = filterModels(sessionCatalogs.get(key) ?? [], store.control.modelPolicy);
      const promptPreference = parseManualPreference(prompt);
      const promptModel = promptPreference?.model ? resolveManualPreference(promptPreference, catalog, null)?.route?.model : null;
      if (store.control.astraRescueOnly) {
        if (!promptModel || catalog.find(model => model.id === promptModel)?.class !== 'strongest') catalog = ordinaryModels(catalog);
        await store.updateSession(key, { rescueAttempts: [], rescueActive: false, lastRescueAttempt: null });
      }
      const info = { current: prompt, prior: store.session(key).activeTask ?? null };
      const state = dossier(info, store.session(key));
      if (store.control.astraRescueOnly) state.model_policy = { astra: 'Reserved for repeated failed standard/high attempts; do not select at the start of a user turn.' };
      const result = currentMode() === 'bypass' ? { error: 'bypass' } : await jev(state, { url: config.jevUrl, key: config.jevKey, timeoutMs: config.timeoutMs, fetchImpl });
      const current = validCurrentRoute(store.session(key).route, catalog);
      const decision = result.answers ? normalizeDecision(result.answers, catalog, current) : fallbackDecision(catalog, current, result.error ?? 'jev_error');
      if (promptModel && !promptPreference.effort) {
        const model = catalog.find(item => item.id === promptModel);
        if (model) decision.route = chooseProfile([model], model.class, result.answers ? decision.effort : 'high');
      } else if (promptModel && promptPreference.effort) decision.route = resolveManualPreference(promptPreference, catalog, current)?.route ?? decision.route;
      const now = Date.now();
      for (const [entryKey, entry] of preflight) if (now - entry.at >= 30000) preflight.delete(entryKey);
      while (preflight.size >= 256) preflight.delete(preflight.keys().next().value);
      preflight.set(preflightKey(key, prompt), { at: now, result });
      const cliPath = fileURLToPath(new URL('../bin/jev-desktop.mjs', import.meta.url));
      const memoryHint = data.session_id ? `node "${cliPath}" memory --session "${data.session_id}" <keywords>` : '';
      return json(res, 200, { decision, guidance: guidance(decision, state.active_task, memoryHint) + ((promptModel && catalog.find(model => model.id === promptModel)?.class === 'strongest') || (promptPreference?.model?.includes('astra') && !sessionCatalogs.has(key))
        ? '\nExplicit one-turn Astra request: use Astra for the main answer and let JEV choose its reasoning effort. Keep subagent models independent.'
        : store.control.astraRescueOnly ? '\nUser model preference: use Luna or Sol normally. Reserve Astra for demonstrated inability to solve the task after repeated Sol/high attempts. Apply this preference to any subagents too.' : '') });
    }
    if (!['GET', 'POST'].includes(req.method) || !/^\/(?:v1\/)?(?:models|responses(?:\/compact)?)$/.test(path)) return json(res, 404, { error: 'not_found' });
    const isModels = path.endsWith('/models');
    const base = isModels || req.headers['chatgpt-account-id'] ? config.upstreamChatgpt : config.upstreamApi;
    if (isModels) {
      const context = catalogRequestContext(req.headers, req.url);
      const upstream = await fetchImpl(targetURL(base, context.path), { method: 'GET', headers: requestHeaders(req.headers), redirect: 'error' });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!upstream.ok) { res.writeHead(upstream.status, responseHeaders(upstream.headers)); return res.end(bytes); }
      const catalogRaw = JSON.parse(bytes.toString('utf8'));
      catalog = normalizeCatalog(catalogRaw);
      catalogs.set(context.key, { catalog, version: context.version, at: Date.now() });
      const out = Buffer.from(JSON.stringify(addAutoModel(catalogRaw)));
      res.writeHead(upstream.status, { ...responseHeaders(upstream.headers), 'content-length': out.length });
      return res.end(out);
    }
    const input = await readBody(req, config.maxRequestBytes);
    let body;
    try { body = JSON.parse(input.toString('utf8')); } catch { return json(res, 400, { error: 'invalid_json' }); }
    let output = input;
    let decision = null;
    if (body.model !== AUTO_MODEL && currentMode() === 'shadow') {
      const info = requestInfo(body, req.headers);
      if (info.fresh) {
        try { catalog = await fetchCatalog(req.headers); } catch { /* shadow must not affect native request */ }
        const actual = { model: body.model, effort: body.reasoning?.effort ?? null };
        const result = await decide(info, info.key, info.current, actual, catalog);
        await store.record(result.decision, { session: info.key, latencyMs: result.latencyMs, shadow: true, actualModel: actual.model, actualEffort: actual.effort });
        await store.updateSession(info.key, { route: actual, activeTask: redact(isShortFollowup(info.current) ? store.session(info.key).activeTask ?? info.current : info.current) });
        await store.archive(info.key, 'user', redact(info.current));
      }
    }
    if (body.model === AUTO_MODEL) {
      try { catalog = await fetchCatalog(req.headers); } catch { /* fallback handled below */ }
      if (!catalog.length) return json(res, 503, { error: 'model_catalog_unavailable', hint: 'Choose a native model or restore the native provider.' });
      catalog = filterModels(catalog, store.control.modelPolicy);
      if (!catalog.length) return json(res, 503, { error: 'no_allowed_model', hint: 'Update the JEV model pool for this client/account.' });
      const info = requestInfo(body, req.headers);
      const key = info.key;
      if (key) sessionCatalogs.set(key, catalog);
      const previous = store.session(key);
      const newTurn = info.fresh || (info.current && !info.continuation && preflight.has(preflightKey(key, info.current)) && !info.auxiliary);
      const fullCatalog = catalog;
      const promptPreference = newTurn ? parseManualPreference(info.current) : null;
      const requestedModel = promptPreference?.model ? resolveManualPreference(promptPreference, fullCatalog, null)?.route?.model : null;
      const progress = rescueProgress(previous, body, fullCatalog);
      if (store.control.astraRescueOnly) {
        if (newTurn) await store.updateSession(key, { rescueAttempts: [], rescueActive: false, lastRescueAttempt: null });
        else if (info.continuation && !info.auxiliary && !path.endsWith('/compact')) await store.updateSession(key, { rescueAttempts: progress.attempts });
        if (!(requestedModel && fullCatalog.find(model => model.id === requestedModel)?.class === 'strongest') && (newTurn || !previous.rescueActive)) catalog = ordinaryModels(catalog);
        if (!catalog.length) return json(res, 503, { error: 'no_ordinary_model', hint: 'Allow a Luna or Sol model for ordinary routing.' });
      }
      const current = validCurrentRoute(previous.route, catalog) ?? chooseProfile(catalog, 'standard', 'high');
      if (newTurn) {
        const mode = currentMode();
        const manual = resolveManualPreference(promptPreference, catalog, current);
        const modelOnly = Boolean(manual?.source === 'prompt_override' && requestedModel && !promptPreference.effort);
        const result = mode === 'bypass' ? { decision: fallbackDecision(catalog, current, 'bypass'), latencyMs: 0 }
          : modelOnly ? await decide(info, key, info.current, current, catalog, false, requestedModel)
          : manual ? { decision: { ...fallbackDecision(catalog, manual.route, manual.source), source: manual.source }, latencyMs: 0 }
          : await decide(info, key, info.current, current, catalog);
        decision = !manual && mode === 'active' ? applyPhaseLease(result.decision, current, catalog, previous.lease, isShortFollowup(info.current)) : result.decision;
        let applied = decision.route ?? current;
        if (store.control.override && !manual) {
          const selected = catalog.find(m => m.id === store.control.override.model && m.efforts.includes(store.control.override.effort));
          if (selected) { applied = store.control.override; decision.source = 'manual_override'; }
        } else if (mode !== 'active') applied = current;
        if (applied && mode !== 'bypass') await store.updateSession(key, { route: applied, activeTask: redact(isShortFollowup(info.current) ? previous.activeTask ?? info.current : info.current), phase: decision.task_mode, lease: decision.lease, risk: decision.risk,
          rescueActive: Boolean(store.control.astraRescueOnly && manual && fullCatalog.find(model => model.id === applied.model)?.class === 'strongest'),
          manualModel: manual?.source === 'prompt_override' && requestedModel ? requestedModel : null });
        if (mode === 'bypass') { applied = current; decision.source = 'bypass'; }
        await store.record({ ...decision, route: applied }, { session: key, latencyMs: result.latencyMs, shadow: mode === 'shadow', actualModel: applied?.model, actualEffort: applied?.effort });
        await store.archive(key, 'user', redact(info.current));
        decision.route = applied;
      } else {
        decision = fallbackDecision(catalog, current, info.continuation ? 'continuation' : 'infrastructure');
        const evidence = toolEvidence(body);
        if (evidence) {
          const safeEvidence = redact(evidence), failureHash = sha(safeEvidence);
          await store.updateSession(key, { evidence: safeEvidence });
          await store.archive(key, 'tool', safeEvidence);
          const failureChanged = store.control.astraRescueOnly ? progress.attempt && previous.lastRescueAttempt !== progress.attempt : unexpectedFailure(evidence) && previous.lastFailureHash !== failureHash;
          if (info.continuation && failureChanged && !previous.manualModel && !info.auxiliary && !path.endsWith('/compact') && currentMode() !== 'bypass') {
            const eligible = store.control.astraRescueOnly && progress.eligible;
            const result = await decide({ current: previous.activeTask ?? info.current ?? 'Continue the active task', prior: null }, key, failureHash, current, eligible ? fullCatalog : catalog, eligible);
            const previousClass = catalog.find(m => m.id === current?.model)?.class;
            const nextClass = catalog.find(m => m.id === result.decision.route?.model)?.class;
            const ranks = { fast: 0, standard: 1, strongest: 2 };
            decision = result.decision;
            if (store.control.astraRescueOnly && !previous.rescueActive && fullCatalog.find(model => model.id === decision.route?.model)?.class !== 'strongest') {
              decision.route = chooseProfile(ordinaryModels(fullCatalog), 'standard', 'high');
            }
            if (previousClass && nextClass && ranks[nextClass] < ranks[previousClass]) decision.route = current;
            if (currentMode() !== 'active') decision.route = current;
            decision.source = `${decision.source}_reassess`;
            await store.updateSession(key, { route: decision.route, lastFailureHash: failureHash, lastRescueAttempt: progress.attempt,
              rescueActive: store.control.astraRescueOnly && fullCatalog.find(model => model.id === decision.route?.model)?.class === 'strongest' });
            await store.record(decision, { session: key, latencyMs: result.latencyMs, shadow: currentMode() === 'shadow', actualModel: decision.route?.model, actualEffort: decision.route?.effort });
          }
        }
      }
      if (!decision.route) return json(res, 503, { error: 'no_usable_model' });
      body.model = decision.route.model;
      body.reasoning = { ...(body.reasoning ?? {}), effort: decision.route.effort };
      if (store.control.footer !== false && !path.endsWith('/compact') && !info.auxiliary) addRouteFooter(body, decision.route);
      output = Buffer.from(JSON.stringify(body));
    }
    const controller = new AbortController();
    const abortOnClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abortOnClose);
    const upstream = await fetchImpl(targetURL(base, req.url), { method: req.method, headers: requestHeaders(req.headers), body: output, signal: controller.signal, redirect: 'error' });
    res.writeHead(upstream.status, responseHeaders(upstream.headers));
    if (!upstream.body) return res.end();
    const observer = new SseObserver();
    const tap = new Transform({ transform(chunk, encoding, callback) {
      observer.push(chunk);
      callback(null, chunk);
    } });
    try { await pipeline(Readable.fromWeb(upstream.body), tap, res, { signal: controller.signal }); }
    finally { res.off('close', abortOnClose); }
    observer.finish();
    const sessionKey = requestInfo(body, req.headers).key;
    if (observer.visible) await store.archive(sessionKey, 'assistant', redact(observer.visible));
    if (decision?.route && observer.usage) {
      await store.updateSession(sessionKey, { cache: { model: decision.route.model, at: Date.now(), cachedTokens: observer.usage.cachedTokens }, usage: observer.usage });
      await store.recordUsage(sessionKey, decision.route, observer.usage);
    }
  })().catch(error => { if (res.headersSent) res.destroy(error); else json(res, error.message === 'request_too_large' ? 413 : 502, { error: error.message === 'request_too_large' ? 'request_too_large' : 'proxy_error' }); }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
  return { server, address: server.address(), store, getCatalog: () => [...catalogs.values()].flatMap(entry => entry.catalog) };
}
