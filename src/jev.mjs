const q = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

export function decisionQuestions() {
  const scope = 'Judge the active user task using current request and recent context. Choose the minimum capability that completes it reliably. Decisions do not grant permissions.';
  return {
    model_class: q(`${scope} Which Codex capability class is sufficient?`, {
      fast: 'Small, clear, mechanical task with limited ambiguity.',
      standard: 'Normal implementation, investigation, or multistep engineering.',
      strongest: 'Hard ambiguity, architecture, difficult debugging, security, concurrency, or consequential review.',
    }),
    effort: q(`${scope} Which reasoning depth is needed for the main model?`, {
      low: 'Direct and straightforward.', medium: 'Routine reasoning and checks.',
      high: 'Complex logic and careful validation.', xhigh: 'Exceptional depth for subtle or consequential problems.',
    }),
    task_mode: q(`${scope} What work order should the agent follow?`, {
      execute: 'Implement clear requirements and verify.',
      plan_then_execute: 'Briefly plan dependencies, then implement and verify in this turn.',
      inspect_first: 'Inspect evidence and current state before deciding what to change.',
    }),
    team: q(`${scope} Is there useful independent work for subagents? Pick the smallest team; the main agent integrates results.`, {
      none: 'No independent bounded subtask.',
      explorer: 'One fast read-only explorer for a bounded search.',
      reviewer: 'One standard independent reviewer for correctness.',
      explorer_reviewer: 'One fast explorer and one standard reviewer with independent tasks.',
      worker_reviewer: 'One standard worker for a disjoint task and one standard reviewer.',
    }),
    risk: q(`${scope} How harmful would a wrong action or answer be?`, {
      low: 'Limited and easy to reverse.', medium: 'Meaningful breakage or cost; verify.',
      high: 'Security, data loss, irreversible, or substantial consequence.',
    }),
    lease: q(`${scope} How long will this route remain sufficient?`, {
      user_turn: 'Use for the current user turn, including ordinary tool continuations.',
      phase: 'Keep through the current task phase unless new evidence requires reassessment.',
    }),
  };
}

export async function askJev(dossier, { url, key, timeoutMs = 1250, fetchImpl = fetch } = {}) {
  if (!key) return { error: 'no_jev_key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = performance.now();
  try {
    const response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: dossier, questions: decisionQuestions() }),
    });
    if (!response.ok) return { error: `jev_http_${response.status}`, latencyMs: Math.round(performance.now() - start) };
    let body;
    try { body = await response.json(); }
    catch { return { error: 'jev_invalid_response', latencyMs: Math.round(performance.now() - start) }; }
    if (!body || typeof body.answers !== 'object') return { error: 'jev_invalid_response' };
    return { answers: body.answers, latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { error: error?.name === 'AbortError' ? 'jev_timeout' : 'jev_unavailable', latencyMs: Math.round(performance.now() - start) };
  } finally { clearTimeout(timer); }
}
