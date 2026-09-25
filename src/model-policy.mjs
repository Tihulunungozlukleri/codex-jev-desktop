export function filterModels(catalog, policy = {}) {
  return catalog.filter(model => (!Array.isArray(policy.allow) || policy.allow.includes(model.id)) &&
    !(policy.deny ?? []).includes(model.id));
}

export function updateModelPolicy(current = {}, operation, ids, catalog) {
  if (!['enable', 'disable', 'only', 'reset'].includes(operation)) throw new Error('invalid_model_operation');
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !/^gpt-[a-z0-9.-]+$/.test(id))) throw new Error('invalid_model_ids');
  if (operation !== 'reset' && !ids.length) throw new Error('model_ids_required');
  if (operation !== 'reset' && !catalog.length) throw new Error('model_catalog_unavailable');
  if (ids.some(id => !catalog.some(model => model.id === id))) throw new Error('unknown_model');
  let allow = current.allow ?? null, deny = current.deny ?? [];
  if (operation === 'reset') return { allow: null, deny: [] };
  if (operation === 'only') { allow = [...new Set(ids)]; deny = []; }
  if (operation === 'disable') deny = [...new Set([...deny, ...ids])];
  if (operation === 'enable') { deny = deny.filter(id => !ids.includes(id)); if (allow) allow = [...new Set([...allow, ...ids])]; }
  const next = { allow, deny };
  if (!filterModels(catalog, next).some(model => model.efforts.length)) throw new Error('cannot_disable_all_models');
  return next;
}

export function validCurrentRoute(route, catalog) {
  return route && catalog.some(model => model.id === route.model && model.efforts.includes(route.effort)) ? route : null;
}
