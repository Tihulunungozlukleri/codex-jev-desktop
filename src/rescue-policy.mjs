import { createHash } from 'node:crypto';
import { toolEvidence, unexpectedFailure } from './context.mjs';

export const ordinaryModels = catalog => catalog.filter(model => model.class !== 'strongest');

// Only the latest completed tool attempt counts. Replayed output and earlier
// failures retained in the conversation must not unlock the expensive model.
export function latestFailureAttempt(body) {
  const item = (Array.isArray(body.input) ? body.input : []).filter(item =>
    ['function_call_output', 'custom_tool_call_output'].includes(item?.type)).at(-1);
  if (!item) return null;
  const text = toolEvidence({ input: [item] });
  if (/\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|network error|rate limit|permission denied|access denied|blocked by policy)\b/i.test(text)) return null;
  const exitCodes = [...text.matchAll(/(?:"exit_code"\s*:\s*|(?:process exited with code|exit code:)\s*)(-?\d+)/gi)].map(match => Number(match[1]));
  if (exitCodes.length && exitCodes.every(code => code === 0)) return null;
  if (!exitCodes.some(code => code !== 0) && !unexpectedFailure(text)) return null;
  return createHash('sha256').update(JSON.stringify([item.call_id ?? item.id ?? null, text])).digest('hex');
}

export function rescueProgress(previous, body, catalog) {
  const attempt = latestFailureAttempt(body);
  const seen = previous.rescueAttempts ?? [];
  const model = catalog.find(model => model.id === previous.route?.model);
  const qualifies = model?.class === 'standard' && ['high', 'xhigh', 'max', 'ultra'].includes(previous.route?.effort);
  const attempts = attempt && qualifies && !seen.includes(attempt) ? [...seen, attempt].slice(-32) : seen;
  return { attempt, attempts, eligible: attempts.length >= 2 };
}

export function explicitRescueDecision(answers) {
  return answers?.model_class?.choice === 'strongest' && Number(answers.model_class.confidence) >= 0.8 &&
    Number(answers.effort?.confidence) >= 0.8;
}
