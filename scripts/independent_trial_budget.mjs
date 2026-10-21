import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { hashFile } from './render_binding.mjs';
import { objectSchema, validateSchema } from './audio_api.mjs';
import { validateEpisodeCallPlan, episodeCallPlanCount, validateCallPlanCapacityChecks } from './episode_call_admission.mjs';

export const independentTrialBudgetDefaults = Object.freeze({ max_requests: 6, max_elapsed_ms: 1200000, max_input_tokens: 8000 });
export const genericAdaptationBudgetDefaults = Object.freeze({ max_requests: 12, max_elapsed_ms: 1200000, max_input_tokens: 16000 });
export const admittedWallClockPolicyRevision = 'admitted-wall-clock-v1';
export function validateReviewInputLimitPolicy(value){
  if(value===null||value===undefined)return null;
  if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='max_input_tokens,revision'
    ||value.revision!=='composite-review-input-48k-v1'||value.max_input_tokens!==48000)
    throw Error('composite_review_input_limit_policy_invalid');
  return {revision:value.revision,max_input_tokens:value.max_input_tokens};
}
export function reviewInputTokenLimit(value,{stage,phase,baseLimit}={}){
  const policy=validateReviewInputLimitPolicy(value);
  return policy&&stage==='composite_research_review'&&['review','recheck'].includes(phase)?policy.max_input_tokens:baseLimit;
}
export function validateTrialWallClockPolicy(value, { maxElapsedMs = 1200000 } = {}) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'max_elapsed_ms,revision'
    || value.revision !== admittedWallClockPolicyRevision || !Number.isSafeInteger(value.max_elapsed_ms)
    || value.max_elapsed_ms <= 0 || value.max_elapsed_ms > maxElapsedMs) throw Error('independent_trial_wall_clock_policy_invalid');
  return { revision: value.revision, max_elapsed_ms: value.max_elapsed_ms };
}
const evidenceBindingSchema = objectSchema({ path: { type: 'string' }, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' } });
const recoveryScopeSchema = { source_video_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' }, output_root: { type: 'string' },
  max_requests: { type: 'integer', minimum: 1, maximum: 12 }, max_elapsed_ms: { type: 'integer', minimum: 1, maximum: 600000 },
  qualified: { type: 'boolean', enum: [false] }, production_approval: { type: 'boolean', enum: [false] } };
export const independentTrialRecoveryAuthorizationSchema = objectSchema({ schema_version: { type: 'integer', enum: [1] },
  kind: { type: 'string', enum: ['human_user_recovery_authorization'] },
  authorization_source: { type: 'string', enum: ['direct_user_message'] }, approved: { type: 'boolean', enum: [true] },
  ...recoveryScopeSchema, received_at: { type: 'string' }, user_request_quote: { type: 'string' } });
export const independentTrialRecoveryGrantSchema = objectSchema({ schema_version: { type: 'integer', enum: [1] },
  kind: { type: 'string', enum: ['independent_trial_budget_supplemental_recovery_grant'] },
  grant_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' }, ...recoveryScopeSchema,
  charged_before: { type: 'integer', minimum: 0 }, cumulative_elapsed_before_ms: { type: 'number', minimum: 1200000 },
  prior_stop: evidenceBindingSchema, human_authorization: evidenceBindingSchema });
// V1 only restores unused request slots after elapsed exhaustion. V2 is an explicit,
// separately authorized supplement; it never changes the original ledger identity.
const originalRecoveryLimitsSchema = objectSchema({ max_requests: { type: 'integer', minimum: 1, maximum: 12 },
  max_elapsed_ms: { type: 'integer', minimum: 1, maximum: 1200000 },
  max_input_tokens: { type: 'integer', minimum: 1, maximum: 16000 } });
const originalRecoveryIdentitySchema = { original_limits: originalRecoveryLimitsSchema,
  original_policy_revision: { type: 'string', enum: ['independent-trial-v1', 'generic-adaptation-v1'] } };
const supplementalRecoveryScopeSchema = { ...recoveryScopeSchema,
  max_requests: { type: 'integer', minimum: 1, maximum: 6 }, ...originalRecoveryIdentitySchema };
export const independentTrialRecoveryAuthorizationV2Schema = objectSchema({ schema_version: { type: 'integer', enum: [2] },
  kind: { type: 'string', enum: ['human_user_recovery_authorization'] },
  authorization_source: { type: 'string', enum: ['direct_user_message'] }, approved: { type: 'boolean', enum: [true] },
  allow_request_limit_extension: { type: 'boolean', enum: [true] },
  ...supplementalRecoveryScopeSchema, received_at: { type: 'string' }, user_request_quote: { type: 'string' } });
export const independentTrialRecoveryGrantV2Schema = objectSchema({ schema_version: { type: 'integer', enum: [2] },
  kind: { type: 'string', enum: ['independent_trial_budget_supplemental_recovery_grant'] },
  grant_id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$' }, ...supplementalRecoveryScopeSchema,
  charged_before: { type: 'integer', minimum: 0 }, cumulative_elapsed_before_ms: { type: 'number', minimum: 0 },
  prior_stop: evidenceBindingSchema, human_authorization: evidenceBindingSchema });

// Submitted images and story/evidence text are bounded separately from CLI setup and the output schema.
// This is an explicit planning estimate, never a claim about provider-reported token usage.
export function estimateTrialInputBudget(input, { prompt = null, frames = input?.frames ?? [], outputSchema,
  fullEstimate = null } = {}) {
  const data = structuredClone(input ?? {}); delete data.schema; delete data.response_schema;
  let bytes = Buffer.byteLength(JSON.stringify(data));
  if (typeof prompt === 'string') {
    const schema = outputSchema ?? input?.schema ?? input?.response_schema;
    let submitted = prompt;
    if (schema) {
      const literal = JSON.stringify(schema);
      if (submitted.includes(literal)) submitted = submitted.replace(literal, '"output-schema-submitted-separately"');
    }
    bytes = Buffer.byteLength(submitted);
  }
  const components = { submitted_text_tokens: Math.ceil(bytes / 3), image_tokens: frames.length * 4096,
    wrapper_allowance_tokens: prompt === null ? 512 : 0 };
  return { revision: 'independent-submitted-input-without-cli-or-output-schema-v1', components,
    submitted_input_tokens: Object.values(components).reduce((sum, value) => sum + value, 0),
    full_planning_estimate: fullEstimate, excludes_cli_context_floor: true, excludes_output_schema: true,
    estimate_is_provider_usage: false, guaranteed_provider_token_ceiling: false };
}

export class IndependentTrialBudgetError extends Error {
  constructor(reason, receipt) {
    super('independent_trial_budget_exhausted'); this.code = this.message;
    this.status = this.message; this.reason = reason; this.receipt_file = receipt?.path ?? null; this.budget_receipt = receipt;
  }
}

export async function createIndependentTrialBudget({ directory, sourceSha256, outputRoot, limits = {}, now = Date.now,
  activeRuns = false, policyRevision = 'independent-trial-v1', wallClockPolicy = null, callPlanPolicy = null,
  reviewInputLimitPolicy = null, admissionStartedAtMs = null } = {}) {
  if (!path.isAbsolute(directory ?? '') || !path.isAbsolute(outputRoot ?? '') || !/^[a-f0-9]{64}$/.test(sourceSha256 ?? ''))
    throw Error('independent_trial_budget_identity_required');
  if (!['independent-trial-v1', 'generic-adaptation-v1'].includes(policyRevision)) throw Error('independent_trial_budget_policy_unknown');
  const defaults = policyRevision === 'generic-adaptation-v1' ? genericAdaptationBudgetDefaults : independentTrialBudgetDefaults;
  const policy = { ...defaults, ...limits };
  for (const key of Object.keys(policy)) if (!Object.hasOwn(defaults, key)
    || !Number.isSafeInteger(policy[key]) || policy[key] <= 0 || policy[key] > defaults[key])
    throw Error('independent_trial_budget_cannot_be_relaxed');
  // Only new, explicitly configured jobs adopt this identity. Existing ledgers
  // cannot gain/remove a deadline by recreating the adapter or resuming a run.
  const wallPolicy = validateTrialWallClockPolicy(wallClockPolicy, { maxElapsedMs: defaults.max_elapsed_ms });
  const callPlan = callPlanPolicy == null ? null : validateEpisodeCallPlan(callPlanPolicy);
  const reviewInputPolicy=validateReviewInputLimitPolicy(reviewInputLimitPolicy);
  if(admissionStartedAtMs!==null&&(!Number.isSafeInteger(admissionStartedAtMs)||admissionStartedAtMs<=0||admissionStartedAtMs>now()))
    throw Error('independent_trial_budget_admission_origin_invalid');
  if (callPlan && (!wallPolicy || callPlan.render_reserve_ms >= wallPolicy.max_elapsed_ms))
    throw Error('episode_call_plan_absolute_deadline_and_render_reserve_required');
  const root = path.resolve(directory), stateFile = path.join(root, 'state.json'), lockFile = path.join(root, 'state.lock');
  const identity = { source_video_sha256: sourceSha256, output_root: path.resolve(outputRoot), limits: policy,
    ...(policyRevision !== 'independent-trial-v1' ? { policy_revision: policyRevision } : {}),
    ...(wallPolicy ? { wall_clock_policy: wallPolicy } : {}), ...(callPlan ? { call_plan_policy: callPlan } : {}),
    ...(reviewInputPolicy?{review_input_limit_policy:reviewInputPolicy}:{}) };
  await mkdir(root, { recursive: true });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  async function locked(action) {
    let lock;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { lock = await open(lockFile, 'wx'); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; await delay(10); }
    }
    if (!lock) throw Error('independent_trial_budget_state_busy');
    try { return await action(); } finally { await lock.close(); await unlink(lockFile); }
  }
  async function save(state) {
    const temporary = path.join(root, `state-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, stateFile);
  }
  async function load() {
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.schema_version !== 1 || !same(state.identity, identity) || !Number.isFinite(state.started_at_ms)
      || !Array.isArray(state.requests)) throw Error('independent_trial_budget_state_identity_changed');
    if (wallPolicy) {
      if(state.wall_clock?.revision!==wallPolicy.revision||state.wall_clock.submitted_at_ms!==state.started_at_ms
        ||state.wall_clock.admitted_at_ms!==state.started_at_ms)throw Error('independent_trial_budget_deadline_identity_changed');
      let deadline=state.started_at_ms+wallPolicy.max_elapsed_ms,origin=state.started_at_ms;
      for(const ref of state.wall_clock.narrowing_receipts??[]){
        const correction=await boundJson(ref), checkpoint=await boundJson(correction.frozen_analysis_checkpoint);
        const original=Date.parse(checkpoint.stages?.analysis?.started_at);
        if(correction.kind!=='analysis_origin_wall_clock_narrowing'||!same(correction.identity,identity)
          ||checkpoint.kind!=='automatic_episode_controller'||checkpoint.source?.sha256!==sourceSha256
          ||!Number.isSafeInteger(original)||original>=origin||correction.analysis_started_at_ms!==original
          ||correction.previous_deadline_at_ms!==deadline||correction.deadline_at_ms!==original+wallPolicy.max_elapsed_ms
          ||correction.deadline_at_ms>=deadline)throw Error('independent_trial_budget_deadline_identity_changed');
        origin=original;deadline=correction.deadline_at_ms;
      }
      if(state.wall_clock.deadline_at_ms!==deadline
        ||(state.wall_clock.effective_started_at_ms??state.started_at_ms)!==origin)
        throw Error('independent_trial_budget_deadline_identity_changed');
    }
    if (callPlan && state.call_admission && !same(state.call_admission.plan, callPlan))
      throw Error('independent_trial_budget_call_plan_identity_changed');
    return state;
  }
  await locked(async () => {
    try { await load(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const startedAt = wallPolicy&&admissionStartedAtMs!==null?admissionStartedAtMs:now();
      await save({ schema_version: 1, identity, started_at_ms: startedAt, started_at: new Date(startedAt).toISOString(),
        ...(wallPolicy ? { wall_clock: { revision: wallPolicy.revision, submitted_at_ms: startedAt, admitted_at_ms: startedAt,
          deadline_at_ms: startedAt + wallPolicy.max_elapsed_ms,
          scope: 'first_budget_admission_includes_slot_wait_and_stopped_time', pre_admission_queue_measured: false } } : {}),
        requests: [], stops: [], cache_hits_count: 0, ...(activeRuns ? { run_history: [], active_run: null } : {}),
        qualified: false, production_approval: false });
    }
  });
  const count = state => state.requests.reduce((sum, row) => sum + (row.confirmed_invocations ?? 1), 0);
  const elapsed = state => Array.isArray(state.run_history)
    ? state.run_history.reduce((sum, run) => sum + Math.max(0, run.finished_at_ms - run.started_at_ms), 0)
      + (state.active_run ? Math.max(0, now() - state.active_run.started_at_ms) : 0)
    : Math.max(0, now() - state.started_at_ms);
  const wallRemaining = state => wallPolicy ? Math.max(0, state.wall_clock.deadline_at_ms - now()) : Infinity;
  const boundedRemaining = (state, activeRemaining) => Math.min(activeRemaining, wallRemaining(state));
  const deadlineFields = state => wallPolicy ? { deadline_at_ms: state.wall_clock.deadline_at_ms,
    wall_clock_revision: wallPolicy.revision, wall_clock_remaining_ms: wallRemaining(state) } : {};
  async function checkWallDeadline(state, input) {
    if (wallPolicy && wallRemaining(state) <= 0) return stop(state, 'per_film_wall_clock_deadline_exhausted', input);
  }
  const renderReserve = () => callPlan?.render_reserve_ms ?? 0;
  const requestRemaining = state => boundedRemaining(state, policy.max_elapsed_ms - elapsed(state)) - renderReserve();
  const callPlanAccounting = state => callPlan ? {
    maximum_requests: episodeCallPlanCount(callPlan),
    phases: Object.fromEntries(Object.entries(callPlan.requests).map(([phase, maximum]) => {
      const charged = state.requests.filter(row => row.call_plan_phase === phase)
        .reduce((sum, row) => sum + (row.confirmed_invocations ?? 1), 0);
      return [phase, { maximum_requests: maximum, charged_request_slots: charged,
        remaining_reserved_requests: Math.max(0, maximum - charged) }];
    })), unknown_invocations_retain_phase_reservations: true,
  } : null;
  async function checkCallPlan(state, { phase, budget } = {}) {
    if (!callPlan) return;
    if (!state.call_admission) return stop(state, 'call_plan_admission_required', { phase, budget });
    if (!Object.hasOwn(callPlan.requests, phase ?? '')) return stop(state, 'call_plan_phase_unplanned', { phase, budget });
    const charged = state.requests.filter(row => row.call_plan_phase === phase)
      .reduce((sum, row) => sum + (row.confirmed_invocations ?? 1), 0);
    if (charged >= callPlan.requests[phase]) return stop(state, 'call_plan_phase_capacity_exceeded', { phase, charged, budget });
    if (requestRemaining(state) <= 0) return stop(state, 'per_film_render_time_reserve_exhausted', { phase, budget });
  }
  async function boundJson(ref) {
    validateSchema(ref, evidenceBindingSchema);
    if (!path.isAbsolute(ref.path) || await hashFile(ref.path) !== ref.sha256) throw Error('independent_trial_recovery_binding_changed');
    const value = JSON.parse(await readFile(ref.path, 'utf8'));
    if (await hashFile(ref.path) !== ref.sha256) throw Error('independent_trial_recovery_binding_changed');
    return value;
  }
  async function checkedRecoveryGrant(ref) {
    const grant = await boundJson(ref), v2 = grant.schema_version === 2;
    validateSchema(grant, v2 ? independentTrialRecoveryGrantV2Schema : independentTrialRecoveryGrantSchema);
    const authority = await boundJson(grant.human_authorization);
    validateSchema(authority, v2 ? independentTrialRecoveryAuthorizationV2Schema : independentTrialRecoveryAuthorizationSchema);
    if (!path.isAbsolute(grant.output_root) || !path.isAbsolute(authority.output_root)
      || grant.source_video_sha256 !== sourceSha256 || path.resolve(grant.output_root) !== identity.output_root
      || authority.source_video_sha256 !== sourceSha256 || path.resolve(authority.output_root) !== identity.output_root
      || grant.max_requests > authority.max_requests || grant.max_elapsed_ms > authority.max_elapsed_ms
      || !v2 && grant.charged_before + grant.max_requests > policy.max_requests
      || v2 && (!same(grant.original_limits, policy) || !same(authority.original_limits, policy)
        || grant.original_policy_revision !== policyRevision || authority.original_policy_revision !== policyRevision)
      || !authority.user_request_quote.trim() || !Number.isFinite(Date.parse(authority.received_at))
      || Date.parse(authority.received_at) > now()) throw Error('independent_trial_recovery_authorization_scope_invalid');
    return grant;
  }
  async function activeGrant(state) {
    if (!state.recovery_grants?.length) return null;
    if (state.recovery_grants.length !== 1) throw Error('independent_trial_recovery_multiple_grants_invalid');
    const row = state.recovery_grants[0], actual = await checkedRecoveryGrant(row.binding);
    if (!same(row.grant, actual)) throw Error('independent_trial_recovery_grant_changed');
    return row;
  }
  const grantCount = (state, row) => state.requests.filter(request => request.recovery_grant_id === row.grant.grant_id)
    .reduce((sum, request) => sum + (request.confirmed_invocations ?? 1), 0);
  const grantElapsed = (state, row) => (state.run_history ?? []).filter(run => run.recovery_grant_id === row.grant.grant_id)
    .reduce((sum, run) => sum + Math.max(0, run.finished_at_ms - run.started_at_ms), 0)
    + (state.active_run?.recovery_grant_id === row.grant.grant_id ? Math.max(0, now() - state.active_run.started_at_ms) : 0);
  function recoverySummary(state, row) {
    if (!row) return null;
    return { grant_id: row.grant.grant_id, grant: row.binding, human_authorization: row.grant.human_authorization,
      prior_stop: row.grant.prior_stop, baseline_charged_request_slots: row.grant.charged_before,
      baseline_cumulative_elapsed_ms: row.grant.cumulative_elapsed_before_ms,
      charged_request_slots: grantCount(state, row), actual_new_cli_invocations: state.requests
        .filter(request => request.recovery_grant_id === row.grant.grant_id && Number.isInteger(request.confirmed_invocations))
        .reduce((sum, request) => sum + request.confirmed_invocations, 0),
      elapsed_ms: grantElapsed(state, row), max_requests: row.grant.max_requests, max_elapsed_ms: row.grant.max_elapsed_ms,
      remaining_requests: Math.max(0, row.grant.max_requests - grantCount(state, row)),
      remaining_ms: Math.max(0, row.grant.max_elapsed_ms - grantElapsed(state, row)),
      ...(row.grant.schema_version === 2 ? { grant_schema_version: 2, request_allowance_kind: 'explicit_additional_requests',
        cumulative_request_ceiling: row.grant.charged_before + row.grant.max_requests,
        original_max_requests: policy.max_requests, original_max_input_tokens: policy.max_input_tokens } : {}),
      original_identity_and_limits_unchanged: true, qualified: false, production_approval: false };
  }
  async function stoppedCheckpoint(binding) {
    if (!binding?.path || await hashFile(binding.path) !== binding.sha256) return null;
    const document = JSON.parse(await readFile(binding.path, 'utf8'));
    const finished = Date.parse(document.updated_at), statuses = Object.values(document.stages ?? {}).map(stage => stage.status);
    if (document.kind !== 'automatic_episode_controller' || document.source?.sha256 !== sourceSha256
      || document.status === 'running' || statuses.includes('running') || !Number.isFinite(finished)
      || finished > now() || finished < (await load()).started_at_ms
      || await hashFile(binding.path) !== binding.sha256) return null;
    return { finished_at_ms: finished, checkpoint: binding };
  }
  async function stop(state, reason, input = null) {
    const file = path.join(root, `stop-${randomUUID()}.json`);
    const recovery = await activeGrant(state);
    const value = { schema_version: 1, status: 'independent_trial_budget_exhausted', reason, identity,
      ...deadlineFields(state),
      elapsed_ms: elapsed(state), wall_elapsed_ms: Math.max(0, now() - (state.wall_clock?.effective_started_at_ms??state.started_at_ms)), actual_new_cli_invocations: state.requests
        .filter(row => Number.isInteger(row.confirmed_invocations)).reduce((sum, row) => sum + row.confirmed_invocations, 0),
      unknown_or_reserved_invocations: state.requests.filter(row => row.confirmed_invocations === null).length,
      charged_request_slots: count(state), input, successful_stage_results_preserved: true,
      other_films_may_continue: true, ...(recovery ? { supplemental_recovery: recoverySummary(state, recovery) } : {}), production_approval: false };
    await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    const receipt = { path: file, sha256: await hashFile(file) };
    state.stops.push(receipt); await save(state); throw new IndependentTrialBudgetError(reason, receipt);
  }
  const inputLimit=(stage,phase)=>reviewInputTokenLimit(reviewInputPolicy,{stage,phase,baseLimit:policy.max_input_tokens});
  const capacityChecksWithPhase=rows=>validateCallPlanCapacityChecks(rows).map((row,index)=>{
    if(rows[index].phase!==undefined&&(typeof rows[index].phase!=='string'||!rows[index].phase.trim()))
      throw Error('episode_call_plan_capacity_check_phase_invalid');
    return {...row,...(rows[index].phase===undefined?{}:{phase:rows[index].phase})};
  });
  async function reasonFor(state, budget, {stage,phase}={}) {
    if (wallPolicy && wallRemaining(state) <= 0) return 'per_film_wall_clock_deadline_exhausted';
    if (callPlan && requestRemaining(state) <= 0) return 'per_film_render_time_reserve_exhausted';
    if (!Number.isSafeInteger(budget?.submitted_input_tokens) || budget.submitted_input_tokens > inputLimit(stage,phase))
      return 'submitted_input_capacity_exceeded';
    const row = await activeGrant(state);
    if (row) {
      if (grantElapsed(state, row) >= row.grant.max_elapsed_ms) return 'supplemental_recovery_elapsed_budget_exhausted';
      if (grantCount(state, row) >= row.grant.max_requests
        || count(state) >= row.grant.charged_before + row.grant.max_requests) return 'supplemental_recovery_request_budget_exhausted';
      return null;
    }
    if (elapsed(state) >= policy.max_elapsed_ms) return 'per_film_elapsed_budget_exhausted';
    if (count(state) >= policy.max_requests) return 'per_film_request_budget_exhausted';
    return null;
  }
  return {
    identity,
    async inspectPhasePlan({ phase, requests = 1, capacityChecks = [] } = {}) { return locked(async () => {
      const state = await load();
      if (!callPlan) return { enforced: false, historical_policy_unchanged: true };
      if (!Number.isSafeInteger(requests) || requests < 1) throw Error('episode_call_plan_phase_request_count_invalid');
      await checkWallDeadline(state, { phase, requests, new_cli_invocations: 0 });
      const phases = callPlanAccounting(state).phases;
      const allocation = Object.hasOwn(phases, phase ?? '') ? phases[phase] : null;
      if (!allocation) return stop(state, 'call_plan_phase_unplanned', { phase, requests });
      if (requests > allocation.remaining_reserved_requests)
        return stop(state, 'call_plan_phase_capacity_exceeded', { phase, requests, allocation });
      if (capacityChecks.length) {
        const checks = capacityChecksWithPhase(capacityChecks);
        if (checks.some(row => row.submitted_input_tokens > inputLimit(row.stage,row.phase??phase)))
          return stop(state, 'submitted_input_capacity_exceeded', { phase, capacity_checks: checks });
      }
      if (requestRemaining(state) <= 0) return stop(state, 'per_film_render_time_reserve_exhausted', { phase, requests });
      return { enforced: true, phase, requests, allocation, ...deadlineFields(state) };
    }); },
    async admitCallPlan({ capacityChecks, availableRequests = policy.max_requests } = {}) { return locked(async () => {
      if (!callPlan) throw Error('episode_call_plan_policy_not_configured');
      const state = await load(), checks = capacityChecksWithPhase(capacityChecks);
      if (!Number.isSafeInteger(availableRequests) || availableRequests < 0) throw Error('episode_call_plan_available_requests_invalid');
      const admission = { plan: callPlan, capacity_checks: checks, available_requests: availableRequests,
        maximum_requests: episodeCallPlanCount(callPlan),
        capacity_scope: 'supplied_preflight_envelopes_plus_dynamic_per_request', implicit_repairs_allowed: 0 };
      if (state.call_admission) {
        if (!same(state.call_admission, admission)) throw Error('independent_trial_budget_call_admission_changed');
        return state.call_admission;
      }
      if (state.requests.length) throw Error('independent_trial_budget_call_admission_requires_zero_prior_requests');
      await checkWallDeadline(state, { stage: 'call_plan_admission', new_cli_invocations: 0 });
      if (admission.maximum_requests > policy.max_requests)
        return stop(state, 'call_plan_request_capacity_exceeded', admission);
      if (admission.maximum_requests > availableRequests)
        return stop(state, 'call_plan_available_requests_insufficient', admission);
      if (checks.some(row => row.submitted_input_tokens > inputLimit(row.stage,row.phase)))
        return stop(state, 'submitted_input_capacity_exceeded', admission);
      if (requestRemaining(state) <= 0) return stop(state, 'per_film_render_time_reserve_exhausted', admission);
      state.call_admission = admission; await save(state); return admission;
    }); },
    async applyRecoveryGrant(ref) { return locked(async () => {
      const state = await load(), grant = await checkedRecoveryGrant(ref);
      if (state.recovery_grants?.length) {
        const current = await activeGrant(state);
        if (!same(current.binding, ref) || current.grant.grant_id !== grant.grant_id)
          throw Error('independent_trial_recovery_grant_replay_or_replacement_rejected');
        return { status: 'supplemental_recovery_grant_already_applied', receipt: current.receipt,
          supplemental_recovery: recoverySummary(state, current) };
      }
      if (!Array.isArray(state.run_history) || state.active_run) throw Error('independent_trial_recovery_stopped_active_history_required');
      if (state.requests.some(request => ![0, 1].includes(request.confirmed_invocations)
        || request.confirmed_invocations === 1 && request.terminated !== true))
        throw Error('independent_trial_recovery_unknown_requests_must_be_reconciled');
      const v2 = grant.schema_version === 2;
      if (grant.charged_before !== count(state) || grant.cumulative_elapsed_before_ms !== elapsed(state)
        || (v2 ? elapsed(state) < policy.max_elapsed_ms && count(state) < policy.max_requests
          : elapsed(state) < policy.max_elapsed_ms) || !state.stops.some(ref => same(ref, grant.prior_stop)))
        throw Error('independent_trial_recovery_original_history_mismatch');
      const previousStop = await boundJson(grant.prior_stop);
      const acceptedReasons = v2 ? ['per_film_elapsed_budget_exhausted', 'per_film_request_budget_exhausted']
        : ['per_film_elapsed_budget_exhausted'];
      if (previousStop.status !== 'independent_trial_budget_exhausted' || !same(previousStop.identity, identity)
        || !acceptedReasons.includes(previousStop.reason)
        || previousStop.reason === 'per_film_request_budget_exhausted' && count(state) < policy.max_requests
        || previousStop.reason === 'per_film_elapsed_budget_exhausted' && elapsed(state) < policy.max_elapsed_ms
        || previousStop.charged_request_slots !== count(state)
        || previousStop.elapsed_ms > elapsed(state)) throw Error('independent_trial_recovery_prior_stop_mismatch');
      const file = path.join(root, `recovery-application-${ref.sha256}.json`);
      const receiptValue = { schema_version: grant.schema_version, kind: 'independent_trial_budget_recovery_application',
        status: 'supplemental_recovery_grant_applied', identity, grant: ref,
        charged_before: count(state), cumulative_elapsed_before_ms: elapsed(state), original_stops_retained: state.stops,
        ...(v2 ? { original_stop_reason: previousStop.reason, explicit_supplemental_request_ceiling: count(state) + grant.max_requests,
          original_limits: policy, original_policy_revision: policyRevision, max_input_tokens_unchanged: true } : {}),
        original_identity_and_limits_unchanged: true, applied_at_ms: now(), qualified: false, production_approval: false };
      await writeFile(file, JSON.stringify(receiptValue, null, 2) + '\n', { flag: 'wx' });
      const receipt = { path: file, sha256: await hashFile(file) };
      const row = { binding: ref, grant, receipt, applied_at_ms: now() };
      state.recovery_grants = [row]; await save(state);
      return { status: 'supplemental_recovery_grant_applied', receipt, supplemental_recovery: recoverySummary(state, row) };
    }); },
    async tightenWallClockFromAnalysis({checkpoint}={}) { return locked(async()=>{
      const state=await load();
      if(!wallPolicy)return {status:'legacy_wall_clock_policy_unchanged'};
      const document=await boundJson(checkpoint), started=Date.parse(document.stages?.analysis?.started_at);
      if(document.kind!=='automatic_episode_controller'||document.source?.sha256!==sourceSha256
        ||!Number.isSafeInteger(started)||started<=0||started>now())
        throw Error('independent_trial_budget_analysis_origin_invalid');
      const proposed=started+wallPolicy.max_elapsed_ms;
      if(proposed>=state.wall_clock.deadline_at_ms)return {status:'existing_wall_clock_deadline_preserved',
        deadline_at_ms:state.wall_clock.deadline_at_ms};
      const id=randomUUID(), frozenFile=path.join(root,`analysis-origin-${id}.json`), receiptFile=path.join(root,`wall-narrowing-${id}.json`);
      await writeFile(frozenFile,JSON.stringify(document,null,2)+'\n',{flag:'wx'});
      const frozen={path:frozenFile,sha256:await hashFile(frozenFile)};
      const value={schema_version:1,kind:'analysis_origin_wall_clock_narrowing',identity,
        original_checkpoint:checkpoint,frozen_analysis_checkpoint:frozen,analysis_started_at_ms:started,
        previous_deadline_at_ms:state.wall_clock.deadline_at_ms,deadline_at_ms:proposed,recorded_at_ms:now(),
        original_started_at_and_cumulative_history_preserved:true,requests_unknowns_and_stops_preserved:true,
        deadline_extended:false,production_approval:false};
      await writeFile(receiptFile,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
      const receipt={path:receiptFile,sha256:await hashFile(receiptFile)};
      state.wall_clock.narrowing_receipts??=[];state.wall_clock.narrowing_receipts.push(receipt);
      state.wall_clock.effective_started_at_ms=started;state.wall_clock.deadline_at_ms=proposed;
      await save(state);return {status:'wall_clock_deadline_narrowed',receipt,deadline_at_ms:proposed};
    }); },
    async openRun({ previous_run_checkpoint } = {}) { return locked(async () => {
      const state = await load(), checkpoint = await stoppedCheckpoint(previous_run_checkpoint);
      const settled = state.requests.every(row => row.confirmed_invocations === 0 || row.terminated === true);
      if (!Array.isArray(state.run_history)) {
        const end = checkpoint && settled ? checkpoint.finished_at_ms : now();
        state.run_history = end > state.started_at_ms ? [{ id: 'legacy-first-run', started_at_ms: state.started_at_ms,
          finished_at_ms: end, recovery: checkpoint && settled ? 'verified_stopped_controller_checkpoint' : 'legacy_unclosed_time_conservatively_retained',
          checkpoint: checkpoint && settled ? checkpoint.checkpoint : null }] : [];
      }
      if (state.active_run) {
        if (state.active_run.pid === process.pid) return state.active_run;
        try { process.kill(state.active_run.pid, 0); throw Error('independent_trial_budget_active_run_busy'); }
        catch (error) { if (error.message === 'independent_trial_budget_active_run_busy' || error.code !== 'ESRCH') throw error; }
        state.run_history.push({ ...state.active_run,
          finished_at_ms: checkpoint && settled && checkpoint.finished_at_ms >= state.active_run.started_at_ms
            ? checkpoint.finished_at_ms : now(),
          recovery: checkpoint && settled ? 'verified_stopped_controller_checkpoint' : 'crashed_unknown_run_conservatively_retained',
          checkpoint: checkpoint && settled ? checkpoint.checkpoint : null });
      }
      const recovery = await activeGrant(state);
      state.active_run = { id: randomUUID(), pid: process.pid, started_at_ms: now(),
        ...(recovery ? { recovery_grant_id: recovery.grant.grant_id } : {}) };
      state.elapsed_scope = 'cumulative_active_runs_excludes_verified_stopped_between_runs';
      await save(state); return state.active_run;
    }); },
    async closeRun() { return locked(async () => {
      const state = await load(); if (!state.active_run) return { active_run_closed: false };
      if (state.active_run.pid !== process.pid) throw Error('independent_trial_budget_run_owner_changed');
      if (state.requests.some(row => row.run_id === state.active_run.id && row.confirmed_invocations === null && row.terminated !== true))
        return { active_run_closed: false, reason: 'unknown_unterminated_child_time_retained' };
      state.run_history.push({ ...state.active_run, finished_at_ms: now(), recovery: 'entry_finally' });
      state.active_run = null; await save(state); return { active_run_closed: true, elapsed_ms: elapsed(state) };
    }); },
    async inspectLocal({ stage, reserveMs = renderReserve(), useRenderReserve = false } = {}) { return locked(async () => {
      const state = await load(); if (Array.isArray(state.run_history) && !state.active_run)
        throw Error('independent_trial_budget_active_run_required');
      await checkWallDeadline(state, { stage, new_cli_invocations: 0 });
      if (!Number.isSafeInteger(reserveMs) || reserveMs < 0) throw Error('independent_trial_local_reserve_invalid');
      const retainedMs = useRenderReserve ? 0 : reserveMs;
      const recovery = await activeGrant(state);
      if (recovery) {
        if (grantElapsed(state, recovery) >= recovery.grant.max_elapsed_ms)
          return stop(state, 'supplemental_recovery_elapsed_budget_exhausted', { stage, new_cli_invocations: 0 });
        const remaining = boundedRemaining(state, recovery.grant.max_elapsed_ms - grantElapsed(state, recovery)) - retainedMs;
        if (remaining <= 0) return stop(state, 'per_film_render_time_reserve_exhausted', { stage, reserve_ms: retainedMs });
        return { remaining_ms: remaining, reserved_render_ms: retainedMs,
          ...deadlineFields(state), new_cli_invocations: 0,
          supplemental_recovery: recoverySummary(state, recovery) };
      }
      if (elapsed(state) >= policy.max_elapsed_ms)
        return stop(state, 'per_film_elapsed_budget_exhausted', { stage, new_cli_invocations: 0 });
      const remaining = boundedRemaining(state, policy.max_elapsed_ms - elapsed(state)) - retainedMs;
      if (remaining <= 0) return stop(state, 'per_film_render_time_reserve_exhausted', { stage, reserve_ms: retainedMs });
      return { remaining_ms: remaining, reserved_render_ms: retainedMs,
        ...deadlineFields(state), new_cli_invocations: 0 };
    }); },
    async inspect({ budget, stage, phase } = {}) { return locked(async () => {
      const state = await load(), reason = await reasonFor(state, budget,{stage,phase}); if (reason) return stop(state, reason, reviewInputPolicy?{budget,stage,phase}:budget);
      if (phase !== undefined) await checkCallPlan(state, { phase, budget });
      const recovery = await activeGrant(state);
      if (recovery) return { remaining_ms: boundedRemaining(state, recovery.grant.max_elapsed_ms - grantElapsed(state, recovery)),
        ...deadlineFields(state),
        remaining_requests: recovery.grant.max_requests - grantCount(state, recovery), limits: policy,
        supplemental_recovery: recoverySummary(state, recovery) };
      return { remaining_ms: boundedRemaining(state, policy.max_elapsed_ms - elapsed(state)) - renderReserve(), ...deadlineFields(state),
        ...(callPlan ? { request_deadline_at_ms: state.wall_clock.deadline_at_ms - renderReserve(), reserved_render_ms: renderReserve() } : {}),
        remaining_requests: policy.max_requests - count(state), limits: policy };
    }); },
    async reserve({ budget, request_sha256, stage, phase, attempt, timeoutMs } = {}) { return locked(async () => {
      const state = await load(); if (Array.isArray(state.run_history) && !state.active_run)
        throw Error('independent_trial_budget_active_run_required');
      const reason = await reasonFor(state, budget,{stage,phase}); if (reason) return stop(state, reason, reviewInputPolicy?{budget,stage,phase}:budget);
      await checkCallPlan(state, { phase, budget });
      const recovery = await activeGrant(state);
      const remaining = boundedRemaining(state, recovery ? recovery.grant.max_elapsed_ms - grantElapsed(state, recovery)
        : policy.max_elapsed_ms - elapsed(state)) - renderReserve(), id = randomUUID();
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw Error('independent_trial_request_timeout_required');
      state.requests.push({ id, request_sha256, stage, attempt, ...(callPlan ? { call_plan_phase: phase } : {}), submitted_input_budget: budget,
        reserved_at_ms: now(), run_id: state.active_run?.id ?? null,
        ...(recovery ? { recovery_grant_id: recovery.grant.grant_id } : {}), status: 'reserved_child_outcome_not_yet_known', confirmed_invocations: null });
      await save(state); return { id, timeoutMs: Math.max(1, Math.min(timeoutMs, remaining)), budget, ...deadlineFields(state),
        ...(callPlan ? { request_deadline_at_ms: state.wall_clock.deadline_at_ms - renderReserve(), reserved_render_ms: renderReserve() } : {}) };
    }); },
    async complete(lease, result) { return locked(async () => {
      const state = await load(), entry = state.requests.find(row => row.id === lease?.id);
      if (!entry || entry.status !== 'reserved_child_outcome_not_yet_known') throw Error('independent_trial_budget_lease_changed');
      entry.confirmed_invocations = result?.spawnError === true ? 0 : result?.runnerThrew === true ? null : 1;
      entry.status = entry.confirmed_invocations === null ? 'child_outcome_unknown' : result?.spawnError ? 'not_spawned' : 'invoked';
      entry.completed_at_ms = now(); entry.timed_out = result?.timedOut === true; entry.terminated = result?.terminated === true;
      await save(state); return { path: stateFile, sha256: await hashFile(stateFile) };
    }); },
    async recordCacheHit() { return locked(async () => { const state = await load(); state.cache_hits_count++;
      await save(state); return { cli_invocations: 0, cache_hits_count: state.cache_hits_count }; }); },
    async snapshot() { return locked(async () => {
      const state = await load(), recovery = await activeGrant(state);
      return { ...state, elapsed_ms: elapsed(state), wall_elapsed_ms: Math.max(0, now() - (state.wall_clock?.effective_started_at_ms??state.started_at_ms)),
        charged_request_slots: count(state), state: { path: stateFile, sha256: await hashFile(stateFile) },
        ...(callPlan ? { call_plan_accounting: callPlanAccounting(state) } : {}),
        ...(recovery ? { supplemental_recovery: recoverySummary(state, recovery) } : {}) };
    }); },
  };
}
