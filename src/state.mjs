import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { secureWrite } from './secrets.mjs';

export const CALIBRATION_TASK_TYPES = new Set(['typo', 'small_edit', 'unit_test', 'simple_bug', 'known_cause_bug',
  'unknown_cause_bug', 'multi_file_refactor', 'whole_repo_refactor', 'architecture', 'security_review', 'migration', 'agentic_research']);

export class StateStore {
  constructor(directory) { this.directory = directory; this.sessions = new Map(); this.seen = new Set(); this.control = { mode: null, override: null, disabled: false, footer: true }; this.lastDecision = null; this.lastControlError = null; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    try { this.control = { ...this.control, ...JSON.parse(await readFile(join(this.directory, 'control'), 'utf8')) }; } catch { /* fresh state */ }
    try {
      const lines = (await readFile(join(this.directory, 'sessions.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean);
      for (const line of lines) { const entry = JSON.parse(line); this.sessions.set(entry.key, { ...this.session(entry.key), ...entry.value }); }
    } catch { /* fresh state */ }
    try {
      const lines = (await readFile(join(this.directory, 'memory.jsonl'), 'utf8')).split(/\r?\n/).filter(Boolean);
      for (const line of lines) { const entry = JSON.parse(line); if (entry.id) this.seen.add(entry.id); }
    } catch { /* fresh state */ }
  }
  session(key) { return this.sessions.get(key) ?? {}; }
  async updateSession(key, value) {
    if (!key) return;
    this.sessions.set(key, { ...this.session(key), ...value });
    await appendFile(join(this.directory, 'sessions.jsonl'), JSON.stringify({ key, value }) + '\n');
  }
  async setControl(change) {
    this.control = { ...this.control, ...change };
    await secureWrite(this.directory, 'control', JSON.stringify(this.control));
  }
  async refreshControl() {
    try { this.control = { ...this.control, ...JSON.parse(await readFile(join(this.directory, 'control'), 'utf8')) }; this.lastControlError = null; }
    catch (error) { this.lastControlError = { code: error.code ?? error.name, path: error.path ?? null }; }
  }
  async record(decision, meta = {}) {
    const safe = { at: new Date().toISOString(), session: meta.session ?? null, model: decision.route?.model ?? null, effort: decision.route?.effort ?? null,
      model_class: decision.model_class, task_mode: decision.task_mode, risk: decision.risk, needs_subagent: decision.needs_subagent,
      subagent_count: decision.subagent_count, confidence: decision.confidence, source: decision.source, latency_ms: meta.latencyMs ?? null,
      shadow: meta.shadow ?? false, actual_model: meta.actualModel ?? null, actual_effort: meta.actualEffort ?? null };
    this.lastDecision = safe;
    await appendFile(join(this.directory, 'decisions.jsonl'), JSON.stringify(safe) + '\n');
  }
  async archive(key, kind, text) {
    if (!key || !text) return;
    const value = String(text).slice(0, 200000);
    const id = createHash('sha256').update(`${key}:${kind}:${value}`).digest('hex');
    if (this.seen.has(id)) return;
    this.seen.add(id);
    await appendFile(join(this.directory, 'memory.jsonl'), JSON.stringify({ id, at: new Date().toISOString(), session: key, kind, text: value }) + '\n');
  }
  async clearMemory() { await writeFile(join(this.directory, 'memory.jsonl'), ''); this.seen.clear(); }
  async recordUsage(session, route, usage) {
    await appendFile(join(this.directory, 'usage.jsonl'), JSON.stringify({ at: new Date().toISOString(), session, model: route.model, effort: route.effort,
      inputTokens: usage.inputTokens ?? null, outputTokens: usage.outputTokens ?? null, cachedTokens: usage.cachedTokens ?? null,
      reasoningTokens: usage.reasoningTokens ?? null }) + '\n');
  }
  async calibrate({ taskType, outcome, retries = 0, elapsedMs = null, manualEscalation = false, session = null }) {
    if (!CALIBRATION_TASK_TYPES.has(taskType) || !['success', 'failure'].includes(outcome) ||
      !Number.isInteger(retries) || retries < 0 || retries > 100 ||
      (elapsedMs !== null && (!Number.isInteger(elapsedMs) || elapsedMs < 0)) || typeof manualEscalation !== 'boolean') {
      throw new Error('invalid_calibration');
    }
    const decisions = (await readFile(join(this.directory, 'decisions.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const decision = session ? decisions.findLast(item => item.session === session) : decisions.at(-1);
    if (!decision) throw new Error('decision_not_found');
    let usage = [];
    try { usage = (await readFile(join(this.directory, 'usage.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
    catch { /* usage not available */ }
    const measured = usage.findLast(item => item.session === decision.session && item.model === decision.model &&
      item.effort === decision.effort && item.at >= decision.at) ?? null;
    const entry = { at: new Date().toISOString(), decisionAt: decision.at, session: decision.session,
      taskType, outcome, retries, elapsedMs, manualEscalation,
      model: decision.model, effort: decision.effort, source: decision.source,
      inputTokens: measured?.inputTokens ?? null, outputTokens: measured?.outputTokens ?? null,
      reasoningTokens: measured?.reasoningTokens ?? null, cachedTokens: measured?.cachedTokens ?? null };
    await appendFile(join(this.directory, 'calibration.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  }
  async report() {
    let lines = [];
    try { lines = (await readFile(join(this.directory, 'decisions.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { /* none */ }
    const counts = {};
    for (const item of lines) counts[`${item.model}/${item.effort}`] = (counts[`${item.model}/${item.effort}`] ?? 0) + 1;
    const latencies = lines.map(x => x.latency_ms).filter(Number.isFinite).sort((a,b) => a-b);
    const pct = p => latencies.length ? latencies[Math.min(latencies.length-1, Math.floor((latencies.length-1)*p))] : null;
    let usage = [];
    try { usage = (await readFile(join(this.directory, 'usage.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { /* none */ }
    const total = key => usage.reduce((sum, item) => sum + (Number(item[key]) || 0), 0);
    const lastBySession = new Map(); let routeChanges = 0;
    for (const item of lines) { const prior = lastBySession.get(item.session); if (prior && prior !== item.model) routeChanges++; lastBySession.set(item.session, item.model); }
    let calibration = [];
    try { calibration = (await readFile(join(this.directory, 'calibration.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
    catch { /* no labels yet */ }
    const byTaskType = {}, byTaskTypeRoute = {};
    for (const item of calibration) {
      for (const [collection, key] of [[byTaskType, item.taskType], [byTaskTypeRoute, `${item.taskType}:${item.model}/${item.effort}`]]) {
        const bucket = collection[key] ?? { total: 0, success: 0, failure: 0, retries: 0, manualEscalations: 0 };
        bucket.total++; bucket[item.outcome]++; bucket.retries += item.retries; bucket.manualEscalations += Number(item.manualEscalation);
        collection[key] = bucket;
      }
    }
    return { turns: lines.length, routes: counts, fallback: lines.filter(x => /^(?:no_jev_key|jev_http_|jev_timeout|jev_unavailable|jev_invalid_response|jev_error)/.test(x.source)).length,
      shadow: lines.filter(x => x.shadow).length, manualOverrides: lines.filter(x => /^(?:manual_override|prompt_override)/.test(x.source)).length,
      routeChanges, latency_p50_ms: pct(.5), latency_p95_ms: pct(.95),
      usage: { inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), cachedTokens: total('cachedTokens'), reasoningTokens: total('reasoningTokens') },
      calibration: { labeled: calibration.length, byTaskType, byTaskTypeRoute },
      estimates: { quotaSavings: null, cacheLoss: null, reason: 'No comparable measured baseline is available.' } };
  }
}
