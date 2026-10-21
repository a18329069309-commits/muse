export const episodeCallPlanRevision = 'episode-call-plan-v1';
export const episodeCallPlanMaximums = Object.freeze({ story: 1, director: 2, selection: 2, assembly: 3,
  review: 1, reselection: 1, edit_repair: 1, recheck: 1, implicit_repair: 0 });

// These are invocation ceilings, including all provider requests used by a
// phase. Splitting a phase or retrying it cannot create another allowance.
export function buildEpisodeCallPlan({ requests = {}, renderReserveMs = 120000 } = {}) {
  return validateEpisodeCallPlan({ revision: episodeCallPlanRevision,
    requests: { ...episodeCallPlanMaximums, ...requests }, render_reserve_ms: renderReserveMs });
}
export function validateEpisodeCallPlan(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'render_reserve_ms,requests,revision'
    || value.revision !== episodeCallPlanRevision || !value.requests || Array.isArray(value.requests)
    || Object.keys(value.requests).sort().join(',') !== Object.keys(episodeCallPlanMaximums).sort().join(',')
    || !Number.isSafeInteger(value.render_reserve_ms) || value.render_reserve_ms < 1 || value.render_reserve_ms >= 1200000)
    throw Error('episode_call_plan_invalid');
  for (const [phase, maximum] of Object.entries(episodeCallPlanMaximums))
    if (!Number.isSafeInteger(value.requests[phase]) || value.requests[phase] < 0 || value.requests[phase] > maximum)
      throw Error('episode_call_plan_phase_ceiling_invalid');
  const requests = Object.fromEntries(Object.keys(episodeCallPlanMaximums).map(phase => [phase, value.requests[phase]]));
  if (Object.values(requests).reduce((a, b) => a + b, 0) < 1) throw Error('episode_call_plan_empty');
  return { revision: value.revision, requests, render_reserve_ms: value.render_reserve_ms };
}
export const episodeCallPlanCount = plan => Object.values(validateEpisodeCallPlan(plan).requests).reduce((a, b) => a + b, 0);

export function episodeCallPlanPhase(input = {}, { attempt = 1 } = {}) {
  if (attempt > 1) return 'implicit_repair';
  if (typeof input.call_plan_phase === 'string') return input.call_plan_phase;
  const stage = input.stage ?? '';
  if (/recheck/.test(stage)) return 'recheck';
  if (/reselection/.test(stage)) return 'reselection';
  if (/edit.*repair|repair.*edit|targeted_edit_revision/.test(stage)) return 'edit_repair';
  if (/review/.test(stage)) return 'review';
  if (/story/.test(stage)) return 'story';
  if (/assembly/.test(stage)) return 'assembly';
  if (/selection|selector|sound_adoption/.test(stage)) return 'selection';
  if (/style|direction|director/.test(stage)) return 'director';
  return null;
}

export function validateCallPlanCapacityChecks(checks) {
  if (!Array.isArray(checks) || checks.length < 1 || checks.some(row => !row || typeof row.stage !== 'string'
    || !row.stage.trim() || !Number.isSafeInteger(row.submitted_input_tokens) || row.submitted_input_tokens < 1))
    throw Error('episode_call_plan_capacity_checks_required');
  return checks.map(({ stage, submitted_input_tokens }) => ({ stage, submitted_input_tokens }));
}
