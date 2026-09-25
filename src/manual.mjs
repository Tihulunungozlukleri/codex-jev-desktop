import { chooseProfile } from './catalog.mjs';

export function parseManualPreference(prompt) {
  const text = String(prompt ?? '').trim();
  if (/\b(?:jev(?:'i)?\s+(?:bu\s+tur\s+)?atla|bypass\s+jev|skip\s+jev)\b/i.test(text)) return { bypass: true };
  const direct = /(?:\bbu\s+tur(?:da|u)?\s+)?(?:\bmodel\s+olarak\s+)?(gpt-[\w.-]+|astra|sol|luna|terra)(?:['’]?(?:y[ıi]|[ıi]))?\s+(?:(low|medium|high|xhigh)\s+)?(?:kullan|seç)\b/i.exec(text);
  if (direct) return { model: direct[1].toLowerCase(), effort: direct[2]?.toLowerCase() ?? null };
  const withModel = /\b(gpt-[\w.-]+|astra|sol|luna|terra)['’]?y?l[ae]\s+.{0,100}?\b(?:dene|dener|deneyebilir|incele|inceler|yap|çöz)\b/i.exec(text);
  if (withModel) return { model: withModel[1].toLowerCase(), effort: null };
  // A direct Turkish request for a model can contain words between "ile" and
  // the action; it is still a one-turn preference, not a persistent policy.
  const action = /\b(gpt-[\w.-]+|astra|sol|luna|terra)(?:['’]?y[ıi])?\s+ile\s+.{0,80}?\b(?:incele|inceler|yap|çöz)\b/i.exec(text);
  if (action) return { model: action[1].toLowerCase(), effort: null };
  const directive = /(?:\buse\s+|\b(?:bu\s+tur(?:u)?\s+)?(?:model\s+olarak\s+)?)(?:(gpt-[\w.-]+|astra|sol|luna|terra)(?:\s+(low|medium|high|xhigh))?\s*(?:ile\s+yap|kullan|seç)?)/i.exec(text);
  const effortOnly = /\b(low|medium|high|xhigh)\s+(?:effort|reasoning)\s+(?:kullan|seç)\b/i.exec(text);
  if (!directive?.[1] && !effortOnly) return null;
  if (directive?.[1] && !/(?:^use\s+|\bile\s+yap\b|\bkullan\b|\bseç\b|\bmodel\s+olarak\b)/i.test(text)) return null;
  return { model: directive?.[1]?.toLowerCase() ?? null, effort: directive?.[2]?.toLowerCase() ?? effortOnly?.[1]?.toLowerCase() ?? null };
}

export function resolveManualPreference(preference, catalog, current) {
  if (!preference) return null;
  if (preference.bypass) return { route: current, source: 'prompt_bypass' };
  let selected = null;
  if (preference.model) {
    const exact = catalog.find(m => m.id.toLowerCase() === preference.model);
    const family = catalog.find(m => m.id.toLowerCase().endsWith(`-${preference.model}`));
    const model = exact ?? family;
    if (!model) return null;
    selected = chooseProfile([model], model.class, preference.effort ?? current?.effort ?? model.defaultEffort ?? 'medium');
  } else if (current) {
    const model = catalog.find(m => m.id === current.model);
    if (model) selected = chooseProfile([model], model.class, preference.effort);
  }
  return selected ? { route: selected, source: 'prompt_override' } : null;
}
