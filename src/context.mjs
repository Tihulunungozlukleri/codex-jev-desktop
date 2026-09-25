import { createHash } from 'node:crypto';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(x => x?.type === 'input_text' || x?.type === 'text').map(x => x.text ?? '').join('\n');
}

export function requestInfo(body, headers = {}) {
  const input = Array.isArray(body?.input) ? body.input : [];
  const hasToolResult = input.some(x => ['function_call_output', 'custom_tool_call_output'].includes(x?.type));
  const hasAdditionalTools = input.some(x => x?.type === 'additional_tools');
  const users = input.filter(x => x?.role === 'user').map(x => textOf(x.content)).filter(Boolean);
  const current = users.at(-1) ?? null;
  const prior = users.at(-2) ?? null;
  const session = headers['thread-id'] ?? body?.client_metadata?.thread_id ?? body?.prompt_cache_key ?? null;
  const key = session ? createHash('sha256').update(String(session)).digest('hex').slice(0, 24) : null;
  const auxiliary = current && /^Generate a concise, single-line task title\b/i.test(current);
  const contextEstimate = Math.round(JSON.stringify(input).length / 4);
  return { key, current, prior, fresh: Boolean(current && hasAdditionalTools && !hasToolResult && !auxiliary), continuation: hasToolResult, auxiliary,
    contextEstimate, repoConstraints: typeof body?.instructions === 'string' ? body.instructions : '' };
}

export function toolEvidence(body) {
  const input = Array.isArray(body?.input) ? body.input : [];
  return input.filter(x => ['function_call_output', 'custom_tool_call_output'].includes(x?.type))
    .map(x => typeof x.output === 'string' ? x.output : textOf(x.output))
    .filter(Boolean).slice(-3).join('\n').slice(-1500);
}

export function unexpectedFailure(evidence) {
  return /\b(?:FAIL|FAILED|AssertionError|tests? failed|exit code:\s*[1-9])\b/i.test(String(evidence ?? ''));
}

export function redact(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|ghp_[A-Za-z0-9]{12,})\b/g, '[REDACTED]')
    .replace(/(^|\n)(\s*(?:Authorization|X-Api-Key|api[_-]?key|password)\s*[:=]\s*)[^\r\n]+/gim, '$1$2[REDACTED]');
}

export function isShortFollowup(value) {
  return Boolean(value && /^(devam|uygula|düzelt|tamam yap|tamam uygula|test et|geri al|ikinci yolu dene|bunu da çöz|aynısını burada yap)[.!\s]*$/i.test(value.trim()));
}

export function dossier(info, state = {}) {
  const active = isShortFollowup(info.current);
  const task = active ? state.activeTask ?? info.prior ?? info.current : info.current;
  return {
    current_user_request: redact(info.current).slice(0, 6000),
    active_task: redact(task).slice(0, 6000),
    recent_user_intent: redact(info.prior ?? '').slice(0, 2000),
    phase: state.phase ?? 'unknown',
    tool_evidence: redact(state.evidence ?? '').slice(0, 1500),
    current_model: state.route?.model ?? null,
    current_effort: state.route?.effort ?? null,
    cache_state: state.cache ?? 'unknown',
    context_estimate: info.contextEstimate ?? null,
    repo_constraints: redact(info.repoConstraints ?? '').slice(0, 1500),
    previous_route: state.route ?? null,
  };
}
