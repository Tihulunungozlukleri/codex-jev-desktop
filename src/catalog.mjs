import { AUTO_MODEL } from './config.mjs';
import { createHash } from 'node:crypto';

const modelClass = id => /astra/i.test(id) ? 'strongest' : /sol|terra/i.test(id) ? 'standard' : /luna/i.test(id) ? 'fast' : null;
const order = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const modelRank = id => {
  const match = /gpt-(\d+)(?:\.(\d+))?/i.exec(id ?? '');
  return (Number(match?.[1] ?? 0) * 100 + Number(match?.[2] ?? 0)) * 10 + (/sol/i.test(id) ? 2 : /terra/i.test(id) ? 1 : 0);
};

export function normalizeCatalog(payload) {
  const list = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.data) ? payload.data : [];
  return list.map(raw => {
    const id = raw.slug ?? raw.model ?? raw.id;
    const efforts = (raw.supported_reasoning_levels ?? raw.supportedReasoningEfforts ?? []).map(x => typeof x === 'string' ? x : x?.effort ?? x?.reasoningEffort).filter(x => order.includes(x));
    return { id, class: modelClass(id), efforts: [...new Set(efforts)], defaultEffort: raw.default_reasoning_level ?? raw.defaultReasoningEffort ?? null,
      enabled: raw.supported_in_api !== false && raw.visibility !== 'hide' && raw.hidden !== true };
  }).filter(m => m.id && m.id !== AUTO_MODEL && m.class && m.enabled);
}

export function catalogRequestContext(headers, path = '/models') {
  const url = new URL(path, 'http://127.0.0.1');
  const explicit = url.searchParams.get('client_version');
  const fromAgent = String(headers['user-agent'] ?? '').match(/\/(\d+\.\d+\.\d+)(?:[-+\s]|$)/)?.[1];
  const version = /^\d+\.\d+\.\d+$/.test(explicit ?? '') ? explicit : fromAgent ?? null;
  if (version) url.searchParams.set('client_version', version);
  const scope = createHash('sha256').update(JSON.stringify([headers['chatgpt-account-id'] ?? '', headers.authorization ?? '', version])).digest('hex');
  return { key: scope, version, path: `/models${url.search}` };
}

export function chooseProfile(catalog, modelClassName, effort, current = null) {
  const usable = catalog.filter(m => m.efforts.length);
  if (!usable.length) return null;
  const classOrder = modelClassName === 'fast' ? ['fast', 'standard', 'strongest'] : modelClassName === 'strongest' ? ['strongest', 'standard', 'fast'] : ['standard', 'strongest', 'fast'];
  const candidate = classOrder.flatMap(cls => usable.filter(m => m.class === cls).sort((a,b) => modelRank(b.id) - modelRank(a.id))).find(Boolean) ?? usable[0];
  const desiredIndex = order.indexOf(effort);
  const selected = candidate.efforts.includes(effort) ? effort : candidate.efforts.slice().sort((a,b) => {
    const da = Math.abs(order.indexOf(a) - desiredIndex), db = Math.abs(order.indexOf(b) - desiredIndex);
    return da - db || order.indexOf(b) - order.indexOf(a);
  })[0];
  if (current && modelClassName === 'current') return current;
  return { model: candidate.id, effort: selected };
}

export function addAutoModel(payload) {
  const key = Array.isArray(payload?.models) ? 'models' : Array.isArray(payload?.data) ? 'data' : null;
  if (!key || payload[key].some(m => (m.slug ?? m.id) === AUTO_MODEL)) return payload;
  const template = payload[key].find(m => /sol/i.test(m.slug ?? m.id ?? '')) ?? payload[key][0];
  if (!template) return payload;
  const auto = { ...template, slug: AUTO_MODEL, id: AUTO_MODEL, model: AUTO_MODEL, display_name: 'Jev Auto', displayName: 'Jev Auto', description: 'JEV chooses model and effort per user turn', visibility: 'list', hidden: false, supported_in_api: true };
  const allowedEfforts = new Set(['low', 'medium', 'high', 'xhigh']);
  if (Array.isArray(auto.supported_reasoning_levels)) auto.supported_reasoning_levels = auto.supported_reasoning_levels.filter(x => allowedEfforts.has(typeof x === 'string' ? x : x?.effort ?? x?.reasoningEffort));
  if (Array.isArray(auto.supportedReasoningEfforts)) auto.supportedReasoningEfforts = auto.supportedReasoningEfforts.filter(x => allowedEfforts.has(typeof x === 'string' ? x : x?.effort ?? x?.reasoningEffort));
  auto.default_reasoning_level = 'medium';
  auto.defaultReasoningEffort = 'medium';
  return { ...payload, [key]: [auto, ...payload[key]] };
}
