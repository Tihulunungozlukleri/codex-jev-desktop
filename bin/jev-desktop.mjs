#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { configFromEnv, codexConfigPath } from '../src/config.mjs';
import { StateStore } from '../src/state.mjs';
import { startServer } from '../src/server.mjs';
import { hiddenInput, secureWrite } from '../src/secrets.mjs';
import { install, uninstall } from '../src/integration.mjs';
import { askJev } from '../src/jev.mjs';
import { normalizeDecision } from '../src/policy.mjs';
import { resolveCodexExecutable } from '../src/codex-runtime.mjs';

const [command = 'doctor', ...args] = process.argv.slice(2);
const config = configFromEnv(process.env, fileURLToPath(new URL('..', import.meta.url)));
const store = new StateStore(config.dataDir);
await store.init();
const execFileAsync = promisify(execFile);
async function startup(action) {
  if (process.platform !== 'win32') throw new Error('Startup tasks are supported on Windows only');
  const script = fileURLToPath(new URL('./jev-startup.ps1', import.meta.url));
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, action], { windowsHide: true });
  return JSON.parse(stdout.trim());
}
async function setControl(change) {
  if (config.adminToken) {
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/admin/control`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jev-admin-token': config.adminToken,
          ...(config.capabilityToken ? { 'x-jev-desktop-token': config.capabilityToken } : {}) },
        body: JSON.stringify(change), signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`Relay control rejected request (${response.status})`);
      return;
    } catch (error) {
      if (!['TypeError', 'TimeoutError'].includes(error.name)) throw error;
    }
  }
  await store.setControl(change);
}
async function adminRequest(path, method, body = null) {
  if (!config.adminToken) throw new Error('Local relay admin token unavailable; start the relay first');
  const response = await fetch(`http://127.0.0.1:${config.port}/admin/${path}`, { method,
    headers: { 'x-jev-admin-token': config.adminToken, ...(body ? { 'content-type': 'application/json' } : {}),
      ...(config.capabilityToken ? { 'x-jev-desktop-token': config.capabilityToken } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Relay admin request failed (${response.status})`);
  return result;
}

try {
  if (command === 'serve') {
    const { address } = await startServer(config, { store });
    process.stdout.write(`Jev Desktop listening on 127.0.0.1:${address.port} (${store.control.mode ?? config.mode})\n`);
  } else if (command === 'shadow' || command === 'active') {
    await setControl({ mode: command, disabled: false });
    process.stdout.write(`Mode: ${command}. New requests use this mode.\n`);
  } else if (command === 'bypass') {
    await setControl({ disabled: true });
    process.stdout.write('JEV bypass requested. The relay uses its last or safe catalog route.\n');
  } else if (command === 'auto') {
    await setControl({ disabled: false, override: null });
    process.stdout.write('Automatic routing restored.\n');
  } else if (command === 'footer-on' || command === 'footer-off') {
    await setControl({ footer: command === 'footer-on' });
    process.stdout.write(`Route footer ${command === 'footer-on' ? 'enabled' : 'disabled'}.\n`);
  } else if (command === 'astra-rescue-only' || command === 'astra-auto') {
    await setControl({ astraRescueOnly: command === 'astra-rescue-only' });
    process.stdout.write(`Astra policy: ${command === 'astra-rescue-only' ? 'rescue only after repeated standard/high failures' : 'automatic'}.\n`);
  } else if (command === 'override') {
    const [model, effort] = args;
    if (!model || !effort) throw new Error('Usage: override <exact-model-id> <effort>');
    await setControl({ override: { model, effort }, disabled: false });
    process.stdout.write('Manual override saved; live catalog will validate the pair before use.\n');
  } else if (command === 'explain') {
    if (config.adminToken) process.stdout.write(JSON.stringify(await adminRequest('explain', 'GET'), null, 2) + '\n');
    else {
      const file = join(config.dataDir, 'decisions.jsonl');
      const lines = (await readFile(file, 'utf8')).trim().split(/\r?\n/);
      process.stdout.write(JSON.stringify(JSON.parse(lines.at(-1)), null, 2) + '\n');
    }
  } else if (command === 'report') {
    process.stdout.write(JSON.stringify(config.adminToken ? await adminRequest('report', 'GET') : await store.report(), null, 2) + '\n');
  } else if (command === 'models') {
    process.stdout.write(JSON.stringify(await adminRequest('catalog', 'GET'), null, 2) + '\n');
  } else if (command === 'model-policy') {
    process.stdout.write(JSON.stringify(await adminRequest('model-policy', 'GET'), null, 2) + '\n');
  } else if (['model-enable', 'model-disable', 'model-only', 'model-reset'].includes(command)) {
    process.stdout.write(JSON.stringify(await adminRequest('model-policy', 'POST', { operation: command.slice(6), models: args }), null, 2) + '\n');
  } else if (command === 'calibrate') {
    const [taskType, outcome, ...rest] = args;
    if (!taskType || !outcome) throw new Error('Usage: calibrate <task-type> <success|failure> [retries] [--session ID] [--elapsed-ms N] [--escalated]');
    const label = { taskType, outcome, retries: 0, elapsedMs: null, manualEscalation: false, session: null };
    let index = 0;
    if (rest[0] && !rest[0].startsWith('--')) { label.retries = Number(rest[0]); index++; }
    while (index < rest.length) {
      const option = rest[index++];
      if (option === '--escalated') label.manualEscalation = true;
      else if (option === '--session' && rest[index]) label.session = createHash('sha256').update(rest[index++]).digest('hex').slice(0, 24);
      else if (option === '--elapsed-ms' && rest[index]) label.elapsedMs = Number(rest[index++]);
      else throw new Error(`Invalid calibration option: ${option}`);
    }
    process.stdout.write(JSON.stringify(await adminRequest('calibrate', 'POST', label), null, 2) + '\n');
  } else if (command === 'memory') {
    let session = null;
    if (args[0] === '--session') { session = args[1] ? createHash('sha256').update(args[1]).digest('hex').slice(0, 24) : null; args.splice(0, 2); }
    const phrase = args.join(' ').toLocaleLowerCase();
    if (!phrase) throw new Error('Usage: memory <search phrase>');
    let hits;
    if (config.adminToken) hits = await adminRequest('memory', 'POST', { session, phrase });
    else {
      const lines = (await readFile(join(config.dataDir, 'memory.jsonl'), 'utf8')).trim().split(/\r?\n/).map(JSON.parse);
      hits = lines.filter(x => (!session || x.session === session) && x.text?.toLocaleLowerCase().includes(phrase)).slice(-10);
    }
    process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
  } else if (command === 'memory-clear') {
    if (config.adminToken) await adminRequest('memory-clear', 'POST');
    else await store.clearMemory();
    process.stdout.write('Local memory archive cleared.\n');
  } else if (command === 'secret' && args[0] === 'set') {
    const value = await hiddenInput();
    if (!value || value.length < 12) throw new Error('No valid key entered');
    await secureWrite(config.dataDir, 'typesafe-key', value);
    process.stdout.write('TypeSafe key saved locally. Restart the relay to load it.\n');
  } else if (command === 'jev-smoke') {
    if (!config.jevKey) throw new Error('TypeSafe key missing; run secret set');
    const state = { current_user_request: 'Fix a small typo in a README file.', active_task: 'Fix a small typo in a README file.',
      recent_user_intent: '', phase: 'new_task', current_model: 'gpt-6-sol', current_effort: 'medium', cache_state: 'unknown' };
    const result = await askJev(state, { url: config.jevUrl, key: config.jevKey, timeoutMs: config.timeoutMs });
    if (!result.answers) throw new Error(`JEV request failed: ${result.error}`);
    const decision = normalizeDecision(result.answers, []);
    process.stdout.write(JSON.stringify({ reachable: true, latencyMs: result.latencyMs, model_class: decision.model_class, effort: decision.effort,
      task_mode: decision.task_mode, risk: decision.risk, needs_subagent: decision.needs_subagent, subagent_count: decision.subagent_count,
      confidence: decision.confidence }, null, 2) + '\n');
  } else if (command === 'install-preview' || command === 'install') {
    const hookPath = fileURLToPath(new URL('./jev-hook.mjs', import.meta.url));
    const result = command === 'install' ? await adminRequest('install', 'POST') : config.adminToken
      ? await adminRequest('install-preview', 'GET')
      : await install({ configPath: codexConfigPath(), dataDir: config.dataDir, port: config.port, hookPath, preview: true });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else if (command === 'uninstall' || command === 'rescue') {
    let result;
    try { result = await adminRequest('uninstall', 'POST'); }
    catch (error) { if (error.cause?.code === 'ECONNREFUSED' || error.name === 'TypeError') result = await uninstall({ dataDir: config.dataDir }); else throw error; }
    const startupResult = process.platform === 'win32' ? await startup('uninstall') : null;
    process.stdout.write(JSON.stringify({ ...result, startup: startupResult }, null, 2) + '\n');
  } else if (command.startsWith('startup-')) {
    const action = command.slice('startup-'.length);
    if (!['preview', 'status', 'install', 'start', 'restart', 'uninstall'].includes(action)) throw new Error('Unknown startup action');
    process.stdout.write(JSON.stringify(await startup(action), null, 2) + '\n');
  } else if (command === 'doctor') {
    let codexText = null;
    try { codexText = await readFile(codexConfigPath(), 'utf8'); } catch { /* absent */ }
    const health = { node: process.version, codexConfig: codexText !== null, codexConfigPath: codexConfigPath(),
      mode: store.control.mode ?? config.mode, jevKeyConfigured: Boolean(config.jevKey), host: config.host, port: config.port,
      dataDir: config.dataDir, globalInstall: Boolean(codexText?.includes('# BEGIN JEV-DESKTOP ROOT')) };
    try { const res = await fetch(`http://127.0.0.1:${config.port}/health`, { headers: config.capabilityToken ? { 'x-jev-desktop-token': config.capabilityToken } : {} });
      health.relay = res.ok ? 'alive' : `http_${res.status}`;
      if (res.ok) { const remote = await res.json(); health.mode = remote.mode; health.jevKeyConfigured = remote.jevKeyConfigured; health.catalogLoaded = remote.catalogLoaded; health.controlError = remote.controlError; health.astraRescueOnly = remote.astraRescueOnly; } }
    catch { health.relay = 'stopped'; }
    if (process.platform === 'win32') { try { const task = await startup('status'); health.startupTask = task.exists && task.owned ? task.state : task.exists ? 'name_conflict' : 'absent'; health.background = task.background; } catch { health.startupTask = 'unknown'; } }
    if (args.includes('--deep')) {
      const deep = { capabilityTokenConfigured: Boolean(config.capabilityToken), adminTokenConfigured: Boolean(config.adminToken) };
      try { const { stdout } = await execFileAsync(await resolveCodexExecutable(), ['--version'], { timeout: 5000, windowsHide: true }); deep.codexVersion = stdout.trim(); }
      catch { deep.codexVersion = null; }
      try {
        const picker = fileURLToPath(new URL('../scripts/check-picker.mjs', import.meta.url));
        const { stdout } = await execFileAsync(process.execPath, [picker, '--installed'], { timeout: 20000, windowsHide: true });
        const result = JSON.parse(stdout);
        deep.codexConfigValid = true;
        deep.jevAutoInModelList = result.jevAutoVisible;
        deep.nativeCatalogReachable = result.models.some(name => name !== 'jev-auto');
      } catch { deep.codexConfigValid = false; deep.jevAutoInModelList = false; deep.nativeCatalogReachable = false; }
      const probe = await askJev({ current_user_request: 'Fix a small README typo.', active_task: 'Fix a small README typo.' },
        { url: config.jevUrl, key: config.jevKey, timeoutMs: config.timeoutMs });
      deep.jevReachable = Boolean(probe.answers);
      deep.jevStatus = probe.answers ? 'ok' : probe.error;
      deep.jevLatencyMs = probe.latencyMs ?? null;
      health.deep = deep;
    }
    process.stdout.write(JSON.stringify(health, null, 2) + '\n');
  } else {
    throw new Error('Commands: serve, doctor, models, model-policy, model-enable, model-disable, model-only, model-reset, astra-rescue-only, astra-auto, shadow, active, bypass, auto, footer-on, footer-off, override, explain, report, calibrate, memory, memory-clear, secret set, jev-smoke, install-preview, install, rescue, uninstall, startup-preview, startup-status, startup-install, startup-start, startup-restart, startup-uninstall');
  }
} catch (error) { process.stderr.write(`Error: ${error.message}\n`); process.exitCode = 1; }
