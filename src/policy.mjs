import { chooseProfile } from './catalog.mjs';

const allowed = {
  model_class: new Set(['fast', 'standard', 'strongest']),
  effort: new Set(['low', 'medium', 'high', 'xhigh']),
  task_mode: new Set(['execute', 'plan_then_execute', 'inspect_first']),
  team: new Set(['none', 'explorer', 'reviewer', 'explorer_reviewer', 'worker_reviewer']),
  risk: new Set(['low', 'medium', 'high']),
  lease: new Set(['user_turn', 'phase']),
};
const defaults = { model_class: 'standard', effort: 'high', task_mode: 'inspect_first', team: 'none', risk: 'medium', lease: 'user_turn' };
const teams = {
  none: [],
  explorer: [{ role: 'explorer', model_class: 'fast', effort: 'medium' }],
  reviewer: [{ role: 'reviewer', model_class: 'standard', effort: 'high' }],
  explorer_reviewer: [{ role: 'explorer', model_class: 'fast', effort: 'medium' }, { role: 'reviewer', model_class: 'standard', effort: 'high' }],
  worker_reviewer: [{ role: 'worker', model_class: 'standard', effort: 'medium' }, { role: 'reviewer', model_class: 'standard', effort: 'high' }],
};
const rank = { fast: 0, standard: 1, strongest: 2 };

export function normalizeDecision(answers = {}, catalog = [], current = null) {
  const value = {}, confidence = {};
  for (const [field, choices] of Object.entries(allowed)) {
    const answer = answers[field];
    value[field] = choices.has(answer?.choice) ? answer.choice : defaults[field];
    const p = Number(answer?.confidence);
    confidence[field] = Number.isFinite(p) && p >= 0 && p <= 1 ? p : 0;
  }
  const primary = Math.min(confidence.model_class, confidence.effort);
  if (primary < 0.6) { value.model_class = 'strongest'; value.effort = 'high'; }
  else if (primary < 0.8 && value.model_class === 'fast') value.model_class = 'standard';
  if (value.risk === 'high') {
    if (rank[value.model_class] < rank.standard) value.model_class = 'standard';
    if (['low', 'medium'].includes(value.effort)) value.effort = 'high';
    if (value.task_mode === 'execute') value.task_mode = 'inspect_first';
  }
  const route = chooseProfile(catalog, value.model_class, value.effort) ?? current;
  const subagents = teams[value.team].map(a => ({ ...a, route: chooseProfile(catalog, a.model_class, a.effort) }));
  return { ...value, route, confidence: primary, confidenceByField: confidence, needs_subagent: subagents.length > 0, subagents, subagent_count: subagents.length, source: 'jev' };
}

export function fallbackDecision(catalog, current = null, reason = 'fallback') {
  const route = current ?? chooseProfile(catalog, 'standard', 'high');
  return { ...defaults, route, confidence: 0, confidenceByField: {}, needs_subagent: false, subagents: [], subagent_count: 0, source: reason };
}

export function applyCacheTieBreak(decision, current, catalog, cache, now = Date.now()) {
  if (!current || !decision.route || decision.model_class !== 'fast' || decision.risk !== 'low') return decision;
  const currentProfile = catalog.find(m => m.id === current.model);
  if (currentProfile?.class !== 'standard' || decision.confidence >= 0.95) return decision;
  if (!cache || cache.model !== current.model || cache.cachedTokens < 8000 || now - cache.at > 300000) return decision;
  return { ...decision, route: current, source: 'cache_tie_break' };
}

export function applyPhaseLease(decision, current, catalog, previousLease, shortFollowup) {
  if (previousLease !== 'phase' || !shortFollowup || !current || !decision.route || decision.risk === 'high') return decision;
  const classes = { fast: 0, standard: 1, strongest: 2 };
  const efforts = { low: 0, medium: 1, high: 2, xhigh: 3, max: 4, ultra: 5 };
  const currentClass = catalog.find(item => item.id === current.model)?.class;
  const nextClass = catalog.find(item => item.id === decision.route.model)?.class;
  if (!currentClass || !nextClass) return decision;
  const downshift = classes[nextClass] < classes[currentClass] ||
    (classes[nextClass] === classes[currentClass] && efforts[decision.route.effort] < efforts[current.effort]);
  return downshift ? { ...decision, route: current, source: 'phase_lease' } : decision;
}

export function guidance(decision, activeTask = '', memoryHint = '') {
  const lines = [
    `Routing advice for the current user task: ${activeTask.slice(0, 600)}`,
    `Task mode: ${decision.task_mode}. Risk: ${decision.risk}. This advice changes no permissions.`,
  ];
  if (decision.task_mode === 'plan_then_execute') lines.push('Make a concise plan, execute it, then verify.');
  if (decision.task_mode === 'inspect_first') lines.push('Inspect relevant state and evidence before editing.');
  if (decision.subagents.length) {
    lines.push(`Up to ${decision.subagent_count} independent bounded subtask(s) may help. Only spawn if the work can run independently:`);
    for (const agent of decision.subagents) lines.push(`- ${agent.role}: ${agent.route?.model ?? agent.model_class} / ${agent.route?.effort ?? agent.effort}`);
    lines.push('Codex decides whether to spawn; wait for results and integrate them. Do not invent agent work.');
  }
  if (memoryHint) lines.push(`If compaction hides an older fact, retrieve its source with: ${memoryHint}`);
  return lines.join('\n');
}
