import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, objectSchema, validateSchema, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { resolveHostBackend } from './host_runtime.mjs';
import { hashFile } from './render_binding.mjs';

const execute = promisify(execFile), str = { type: 'string' }, strings = { type: 'array', items: str };
const here = path.dirname(fileURLToPath(import.meta.url));
const relationship = { type: 'string', enum: ['family', 'romance', 'hostile', 'institutional', 'other', 'unknown'] };
const threat = { type: 'string', enum: ['unresolved', 'resolved', 'not_present', 'unknown'] };
export const caseComparisonSchema = objectSchema({ decisions: { type: 'array', items: objectSchema({
  cue_id: str, case_id: str, verdict: { type: 'string', enum: ['applicable', 'rejected', 'unknown'] }, reason: str,
  steps: { type: 'array', items: objectSchema({ target_story_step_id: str, reference_story_step_id: str,
    target_relationship: relationship, reference_relationship: relationship,
    target_threat: threat, reference_threat: threat,
    current_condition_quote: str, reference_condition_quote: str, semantic_basis: str,
    critical_conflicts: strings }) },
  unresolved: strings,
}) } });
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const relationshipClasses = { family: 'family', mother_daughter: 'family', romantic: 'romance', romance: 'romance',
  hostile: 'hostile', institutional: 'institutional', other: 'other' };
const referenceInput = row => ({ case_id: row.case_id, work_title: row.work.title,
  reference_case_binding: row.reference_case_binding, source_video: row.source_video,
  source_range: row.source_range, description: row.description, conditions: row.conditions,
  story_sequence: row.story_sequence, development_preset: row.development_preset,
  evidence_summary: row.evidence_summary, music_pack_ids: row.music_pack_ids,
  unresolved_gaps: row.unresolved_gaps.slice(0, 3) });
const readBound = async value => {
  await verifyEvidenceBindings(value); return readJson(value.path);
};

// Check the immutable SQLite record, rather than trusting an exported case ID or model-created case.
export async function verifyReferenceCaseBindings(bindings, python = 'python') {
  const groups = new Map();
  for (const row of bindings) {
    if (!row?.database || !row.case_id || !/^[a-f0-9]{64}$/.test(row.record_sha256 ?? ''))
      throw new Error('reference_case_record_binding_required');
    const key = path.resolve(row.database.path);
    if (!groups.has(key)) groups.set(key, { database: row.database, rows: [] });
    if (groups.get(key).database.sha256 !== row.database.sha256) throw new Error('conflicting_reference_store_identity');
    groups.get(key).rows.push(row);
  }
  const checked = [];
  for (const { database, rows } of groups.values()) {
    await verifyEvidenceBindings(database);
    const code = 'import sys,json,sqlite3,pathlib,hashlib\n'
      + 'db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True)\n'
      + 'result=[]\n'
      + 'for binding in json.loads(sys.argv[2]):\n'
      + ' row=db.execute("SELECT c.record_json,e.record_json,w.record_json FROM cases c JOIN episodes e USING(episode_id) JOIN works w USING(work_id) WHERE c.case_id=?",(binding["case_id"],)).fetchone()\n'
      + ' if not row or hashlib.sha256(row[0].encode()).hexdigest()!=binding["record_sha256"]: raise ValueError("reference_case_changed_or_missing")\n'
      + ' case,episode,work=map(json.loads,row)\n'
      + ' if work.get("split")=="heldout": raise ValueError("heldout_case_cannot_be_consumed")\n'
      + ' result.append({"case":case,"episode":episode,"work":work})\n'
      + 'print(json.dumps(result,ensure_ascii=False))\n';
    const result = await execute(python, ['-X', 'utf8', '-c', code, database.path, JSON.stringify(rows)],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    await verifyEvidenceBindings(database); checked.push(...JSON.parse(result.stdout));
  }
  return checked;
}

export function validateCaseComparison(decision, cue, reference) {
  if (decision.cue_id !== cue.cue_id || decision.case_id !== reference.case_id)
    throw new Error('case_comparison_identity_mismatch');
  if (decision.verdict !== 'applicable') return { applicable: false, gaps: [decision.verdict] };
  if (!decision.reason.trim() || !decision.steps.length) throw new Error('actual_ordered_semantic_basis_required');
  let lastTarget = -1, lastReference = -1;
  for (const mapped of decision.steps) {
    const i = cue.story_sequence.findIndex(step => step.step_id === mapped.target_story_step_id);
    const j = reference.story_sequence.findIndex(step => step.step_id === mapped.reference_story_step_id);
    if (i <= lastTarget || j <= lastReference) throw new Error('semantic_step_order_or_identity_invalid');
    const current = cue.story_sequence[i], prior = reference.story_sequence[j];
    if (!mapped.semantic_basis.trim() || !mapped.current_condition_quote.trim() || !mapped.reference_condition_quote.trim()
      || !JSON.stringify(current).includes(mapped.current_condition_quote)
      || !JSON.stringify(prior).includes(mapped.reference_condition_quote))
      throw new Error('semantic_condition_quote_not_in_actual_record');
    if (mapped.critical_conflicts.length || ['family', 'romance'].includes(mapped.target_relationship)
      && mapped.reference_relationship !== mapped.target_relationship
      || mapped.target_threat === 'unresolved' && mapped.reference_threat === 'resolved')
      throw new Error('critical_story_conflict');
    // Explicit boolean facts cannot be contradicted by the semantic comparator's canonical classes.
    for (const [step, state] of [[current, mapped.target_threat], [prior, mapped.reference_threat]]) {
      const end = step.after?.threat_resolved;
      if (end === false && state !== 'unresolved' || end === true && state !== 'resolved')
        throw new Error('semantic_threat_class_contradicts_record');
    }
    for (const [step, state] of [[current, mapped.target_relationship], [prior, mapped.reference_relationship]])
      for (const phase of ['before', 'after']) {
        const actual = relationshipClasses[step[phase]?.relationship];
        if (actual && actual !== state) throw new Error('semantic_relationship_class_contradicts_record');
      }
    lastTarget = i; lastReference = j;
  }
  const mapped = new Set(decision.steps.map(step => step.target_story_step_id));
  return { applicable: true, gaps: cue.story_sequence.filter(step => !mapped.has(step.step_id))
    .map(step => 'unmapped_current_story_step:' + step.step_id) };
}

function assertActualReference(checked, reference) {
  const actual = checked?.case;
  if (!actual || ['conditions', 'story_sequence', 'development_preset', 'source_range',
    'music_pack_ids', 'theme_bundle_ids', 'sound_pack_ids', 'sound_actions', 'source_events'].some(key =>
    canonical(actual[key] ?? (key.endsWith('_ids') ? [] : {}))
      !== canonical(reference[key]))
    || (actual.description ?? '') !== reference.description || actual.status !== reference.case_status
    || checked.episode.episode_id !== reference.episode_id
    || canonical(checked.work) !== canonical(reference.work)
    || canonical(checked.episode.source_video) !== canonical(reference.source_video)
    || canonical(Object.fromEntries(['evidence_status', 'actual_audio_processed', 'actual_video_processed', 'artistic_approval']
      .map(key => [key, actual.evidence?.[key] ?? null]))) !== canonical(reference.evidence_summary))
    throw new Error('exported_reference_case_changed');
}

async function verifySemanticHostRecord(raw, response, sourceSha, query, cue, reference) {
  if (raw.execution_kind !== 'codex_host_authored_record') return false;
  if (raw.inference_claim !== 'host_record_import_not_api_inference'
    || raw.actual_input_processed !== true || raw.completion_status !== 'complete' || raw.actual_audio_processed !== false
    || raw.actual_video_processed !== false || raw.qualified !== false || raw.artistic_approval !== false
    || raw.production_approval !== false || canonical(raw.scopes) !== '[]' || raw.source_video_sha256 !== sourceSha)
    throw new Error('semantic_host_record_claim_invalid');
  const backend = resolveHostBackend(raw.backend);
  await verifyEvidenceBindings(raw.evidence_files);
  const requestBinding = raw.evidence_files?.find(row => path.resolve(row.path) === path.join(path.dirname(response.path), 'request.json'));
  if (!requestBinding) throw new Error('paired_semantic_host_request_required');
  const request = await readJson(requestBinding.path), payload = request.payload;
  if (raw.request_sha256 !== request.request_sha256 || raw.request_sha256 !== shaBytes(canonical(payload))
    || canonical(request.backend) !== canonical(backend) || canonical(payload.backend) !== canonical(backend)
    || raw.model !== backend.model_revision || raw.backend_id !== backend.backend_id || raw.model_revision !== backend.model_revision
    || payload.source_video_sha256 !== sourceSha || payload.role !== 'ordered_reference_case_semantic_comparison'
    || canonical(raw.input_bindings) !== canonical(payload.input_bindings)
    || canonical(raw.evidence_files) !== canonical([requestBinding, ...payload.input_bindings])
    || payload.input?.stage !== 'ordered_reference_case_semantic_comparison'
    || canonical(payload.input.data.current_query) !== canonical(query)
    || canonical(payload.input.data.current_cue) !== canonical(cue)
    || !payload.input.data.references?.some(row => canonical(row) === canonical(referenceInput(reference)))
    || !payload.input.data.recalled_candidates?.sha256
    || !payload.input_bindings.some(row => canonical(row) === canonical(payload.input.data.recalled_candidates)))
    throw new Error('semantic_host_request_identity_mismatch');
  const recalled = await readBound(payload.input.data.recalled_candidates);
  if (recalled.source_video_sha256 !== sourceSha || recalled.store_sha256 !== reference.reference_case_binding.database.sha256
    || !recalled.cues?.find(row => row.cue_id === cue.cue_id)?.candidates.some(row => canonical(row) === canonical(reference)))
    throw new Error('semantic_host_candidate_pool_mismatch');
  return true;
}

export async function compileSemanticCaseRoute({ decision, cue, reference, response, source_video_sha256, query, python = 'python' }) {
  const result = validateCaseComparison(decision, cue, reference);
  if (!result.applicable) return null;
  await verifyEvidenceBindings(response);
  const raw = await readJson(response.path);
  const hostRecord = await verifySemanticHostRecord(raw, response, source_video_sha256, query, cue, reference);
  if ((!hostRecord && raw.actual_runtime_executed !== true) || raw.actual_input_processed !== true
    || raw.actual_audio_processed !== false || raw.completion_status !== 'complete'
    || !/^[a-f0-9]{64}$/.test(source_video_sha256 ?? '') || raw.source_video_sha256 !== source_video_sha256
    || !raw.value?.decisions?.some(row => canonical(row) === canonical(decision)))
    throw new Error('actual_case_comparison_response_required');
  const [checked] = await verifyReferenceCaseBindings([reference.reference_case_binding], python);
  assertActualReference(checked, reference);
  await verifyEvidenceBindings(reference.source_video);
  return { route_id: `${cue.cue_id}:${reference.case_id}:semantic-no-pack`, cue_id: cue.cue_id,
    case_ids: [reference.case_id], music_pack_id: null, source_candidates: [], sound_candidates: [], theme_bundles: [],
    reference_case_binding: reference.reference_case_binding, case_evidence: reference.evidence_summary,
    source_format: reference.source_format, reference_source: reference.source_video,
    reference_work_id: checked.work.work_id, reference_episode_id: checked.episode.episode_id,
    reference_case_range: checked.case.source_range, ...(query ? { semantic_query_binding: query } : {}),
    reference_source_events: reference.source_events, beat_action_map: reference.sound_actions,
    development_preset: reference.development_preset,
    structure_match: { mode: 'host_ordered_semantic_research', semantic_assessment: 'actual_host_comparison',
      semantic_evidence: response, steps: decision.steps, matched_conditions: {}, critical_conflicts_excluded: true,
      required_target_story_step_ids: cue.story_sequence.map(step => step.step_id) },
    applicability: { case_status: reference.case_status, reference_case_record_checked: true,
      reference_source_hash_checked: true, reference_evidence_record_checked: false,
      current_review_required: true, formal_adoption_allowed: false },
    unresolved_gaps: [...result.gaps, ...decision.unresolved, 'case_has_no_music_pack',
      'reference_music_effectiveness_unverified', 'current_material_selection_required'] };
}

export async function hydrateSemanticCaseRoutes(config, routes) {
  const query = await readBound(config.query);
  await verifyEvidenceBindings(config.database);
  const library = config.library_db ? await bind(config.library_db) : null;
  const input = await saveJson(path.join(config.output_dir, 'semantic-material-input.json'), {
    source_video_sha256: query.source_video_sha256, store_sha256: config.database.sha256,
    usage_scope: query.usage_scope, cues: query.cues, routes, library_sha256: library?.sha256 ?? null,
  });
  const output = path.join(config.output_dir, 'semantic-materials.json');
  await execute(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'case_preset_store.py'),
    'hydrate-semantic', '--db', config.database.path, '--input', input.path, '--out', output,
    ...(library ? ['--library-db', library.path] : [])], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  await verifyEvidenceBindings([config.query, config.database, input, ...(library ? [library] : [])]);
  const result = await readJson(output);
  if (result.store_sha256 !== config.database.sha256 || result.library_sha256 !== (library?.sha256 ?? null)
    || result.formal_adoption_allowed !== false) throw new Error('semantic_material_hydration_binding_mismatch');
  return result;
}

// A composeEpisode runtime.caseMatcher: preserve the natural query and use its actual host session.
export function createCaseMatcher({ python = 'python', cacheDirectory, candidatePool, packageLinkedOnly = false,
  reviewLinkedOnly = false } = {}) {
  return async (config, session) => {
    const query = await readBound(config.query);
    await verifyEvidenceBindings(config.database);
    if (query.schema_version !== 2 || query.usage_scope !== 'research_noncommercial')
      throw new Error('host_semantic_recall_requires_v2_research_query');
    if (candidatePool) await verifyEvidenceBindings(candidatePool);
    const candidates = path.join(config.output_dir, 'case-lexical-candidates.json');
    await execute(python, ['-X', 'utf8', path.join(here, 'case_text_recall.py'), '--db', config.database.path,
      '--request', config.query.path, '--cache', path.join(cacheDirectory ?? config.output_dir, `case-fts-${config.database.sha256}.sqlite`),
      '--out', candidates, ...(candidatePool ? ['--pool', candidatePool.path, '--pool-sha256', candidatePool.sha256] : [])],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    await verifyEvidenceBindings([config.query, config.database, ...(candidatePool ? [candidatePool] : [])]);
    return compareCaseCandidates({ ...config, candidates: await bind(candidates), python, packageLinkedOnly, reviewLinkedOnly }, session);
  };
}

/** Consume at most five detailed real references per cue after a bounded offline recall.
 * FTS recall itself is lexical; this actual host result is a research semantic assessment,
 * not hearing approval or proof that the reference music worked.
 */
export async function compareCaseCandidates(config, session) {
  const query = await readBound(config.query), recalled = await readBound(config.candidates);
  if (query.source_video_sha256 !== recalled.source_video_sha256 || recalled.store_sha256 !== config.database.sha256
    || query.store_sha256 !== config.database.sha256 || !Array.isArray(recalled.cues)
    || typeof session?.director !== 'function') throw new Error('case_comparison_bound_recall_required');
  await verifyEvidenceBindings(config.database);
  const allRoutes = [], coverage = [], comparisons = [], packageLinkageSkips = [];
  let declaredReviewPacks;
  if (config.reviewLinkedOnly) {
    const code = 'import sqlite3,json,sys,pathlib\nc=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True)\n'
      + 't={r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}\nr=[]\n'
      + 'if "windows" in t:\n for k,s in c.execute("SELECT pack_id,record_json FROM windows"):\n  if json.loads(s).get("human_review_record"):r.append(k)\n'
      + 'if "sound_packs" in t:\n for k,s in c.execute("SELECT sound_pack_id,record_json FROM sound_packs"):\n  if any(m.get("human_review_record") for m in json.loads(s).get("members",[])):r.append(k)\n'
      + 'if "theme_members" in t:\n r.extend(k for k,p in c.execute("SELECT theme_bundle_id,pack_id FROM theme_members") if p in set(r))\n'
      + 'print(json.dumps(r))\n';
    const result = await execute(config.python || 'python', ['-X', 'utf8', '-c', code, config.database.path],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    await verifyEvidenceBindings(config.database);
    declaredReviewPacks = new Set(JSON.parse(result.stdout));
  }
  for (const cue of query.cues) {
    const pool = recalled.cues.find(row => row.cue_id === cue.cue_id)?.candidates ?? [];
    const limit = query.limit ?? 20;
    if (![20, 50].includes(limit) || pool.length > limit) throw new Error('case_recall_limit_twenty_or_fifty');
    const inspected = Array.isArray(query.inspected_comparisons)
      ? query.inspected_comparisons.filter(row => row.cue_id === cue.cue_id).map(row => row.case_id) : (query.inspected_case_ids ?? []);
    const linked = row => [row.music_pack_ids, row.sound_pack_ids, row.theme_bundle_ids].some(ids => Array.isArray(ids)
      && ids.some(id => !declaredReviewPacks || declaredReviewPacks.has(id)));
    const filterAvailability = config.packageLinkedOnly || config.reviewLinkedOnly;
    const skipped = filterAvailability ? pool.filter(row => !linked(row)) : [];
    if (skipped.length) {
      const actualSkipped = await verifyReferenceCaseBindings(skipped.map(row => row.reference_case_binding), config.python);
      const records = new Map(actualSkipped.map(row => [row.case.case_id, row]));
      for (const row of skipped) assertActualReference(records.get(row.case_id), row);
    }
    for (const row of skipped) packageLinkageSkips.push({ cue_id: cue.cue_id, case_id: row.case_id,
      reference_case_binding: row.reference_case_binding, reason: config.reviewLinkedOnly
        ? 'reference_case_has_no_declared_offline_review_window' : 'reference_case_material_binding_missing',
      semantic_assessment_performed: false, material_approval: false });
    const supplied = pool.filter(row => !inspected.includes(row.case_id) && (!filterAvailability || linked(row))).slice(0, 5);
    if (!supplied.length) { coverage.push({ cue_id: cue.cue_id, case_count: 0, recalled_case_count: pool.length,
      package_unbound_case_count: skipped.length, gaps: [skipped.length ? 'recalled_cases_have_no_material_bindings' : 'no_recalled_case'] }); continue; }
    const raw = await verifyReferenceCaseBindings(supplied.map(row => row.reference_case_binding), config.python);
    const actual = new Map(raw.map(row => [row.case.case_id, row]));
    for (const reference of supplied) {
      assertActualReference(actual.get(reference.case_id), reference);
    }
    const request = { stage: 'ordered_reference_case_semantic_comparison', frames: [], schema: caseComparisonSchema,
      prompt: 'Compare the CURRENT story steps to the supplied actual readonly REFERENCE cases. '
        + 'Return one decision per supplied reference and preserve both raw descriptions. Do not rename functions to make exact equality pass. '
        + 'Applicable can map a compatible ordered subset; explicitly leave unmatched current events unresolved. '
        + 'A threatened victim, attempted intervention and completed victory differ. Family recognition is not romance; unresolved threat is not victory. '
        + 'Each mapped step needs exact quotes from the current/reference step and an explicit semantic explanation. '
        + 'Canonical relationship and threat classes are your interpretation of these actual texts, not audio facts. '
        + 'after.threat_resolved=false requires unresolved, true requires resolved; mixed/unknown changes remain unknown or rejected. '
        + 'Reference music observations and proposed presets are research predictions; never call them successful music evidence. '
        + 'No audio is supplied, no music is selected and no hearing or artistic qualification is granted.',
      data: { source_video_sha256: query.source_video_sha256, current_query: config.query, recalled_candidates: config.candidates,
        frozen_case_store: config.database, current_cue: cue,
        references: supplied.map(referenceInput) } };
    const response = await session.director(request); validateSchema(response.value, caseComparisonSchema);
    const seen = new Set(), mappedRoutes = [], validationRejections = [];
    for (const decision of response.value.decisions) {
      const reference = supplied.find(row => row.case_id === decision.case_id);
      if (!reference || seen.has(decision.case_id)) throw new Error('comparison_missing_or_duplicate_case_identity');
      seen.add(decision.case_id);
      let result;
      try { result = validateCaseComparison(decision, cue, reference); }
      catch (error) {
        // A model's inconsistent applicability claim is an explicit rejected candidate,
        // not a reason to abandon independent candidates or the next episode.
        if (!['critical_story_conflict', 'semantic_threat_class_contradicts_record', 'semantic_relationship_class_contradicts_record',
          'semantic_step_order_or_identity_invalid', 'semantic_condition_quote_not_in_actual_record',
          'actual_ordered_semantic_basis_required'].includes(error.message)) throw error;
        validationRejections.push({ case_id: decision.case_id, raw_verdict: decision.verdict,
          effective_verdict: 'rejected_by_constraint_validation', error: error.message,
          raw_response: response.raw_response }); continue;
      }
      if (!result.applicable) continue;
      mappedRoutes.push(await compileSemanticCaseRoute({ decision, cue, reference, response: response.raw_response,
        source_video_sha256: query.source_video_sha256, query: config.query, python: config.python }));
    }
    if (seen.size !== supplied.length) throw new Error('every_supplied_case_requires_actual_decision');
    allRoutes.push(...mappedRoutes); comparisons.push({ cue_id: cue.cue_id, response: response.raw_response,
      recall_count: pool.length, detailed_host_count: supplied.length, decisions: response.value.decisions,
      validation_rejections: validationRejections });
    coverage.push({ cue_id: cue.cue_id, recalled_count: pool.length, compared_count: supplied.length,
      case_count: mappedRoutes.length, source_candidate_count: 0,
      gaps: [...(mappedRoutes.length ? ['actual_music_pack_binding_pending'] : ['no_semantically_compatible_reference_in_inspected_pool']),
        ...(validationRejections.length ? ['actual_host_applicability_conflict_rejected'] : [])] });
    await saveJson(path.join(config.output_dir, cue.cue_id.replaceAll('/', '_') + '-comparison.json'), comparisons.at(-1));
  }
  const materials = await hydrateSemanticCaseRoutes(config, allRoutes);
  const hydrated = materials.routes;
  for (const item of coverage) {
    const selected = hydrated.filter(route => route.cue_id === item.cue_id);
    item.source_candidate_count = selected.reduce((count, route) => count + route.source_candidates.length, 0);
    item.sound_candidate_count = selected.reduce((count, route) => count + route.sound_candidates.length, 0);
    const cue = query.cues.find(row => row.cue_id === item.cue_id), covered = new Set(selected.flatMap(route =>
      route.structure_match.steps.map(step => step.target_story_step_id)));
    item.required_target_story_step_ids = cue.story_sequence.map(step => step.step_id);
    item.covered_target_story_step_ids = item.required_target_story_step_ids.filter(id => covered.has(id));
    item.uncovered_target_story_step_ids = item.required_target_story_step_ids.filter(id => !covered.has(id));
    item.step_coverage_status = item.uncovered_target_story_step_ids.length ? 'partial_ordered_research_mapping' : 'all_steps_mapped_not_material_approval';
    item.gaps.push(...item.uncovered_target_story_step_ids.map(id => 'unmapped_current_story_step:' + id));
    item.gaps = item.gaps.filter(gap => gap !== 'actual_music_pack_binding_pending');
    if (selected.length && !item.source_candidate_count) item.gaps.push('actual_music_pack_binding_pending');
    else if (selected.length && !selected.some(route => route.source_candidates.some(c => c.applicability.eligible_for_current_review)))
      item.gaps.push('no_eligible_source_for_current_review');
  }
  await verifyEvidenceBindings([config.query, config.candidates, config.database]);
  const result = { schema_version: 2, source_video_sha256: query.source_video_sha256,
    store_sha256: config.database.sha256, status: hydrated.some(route => route.source_candidates.some(c => c.applicability.eligible_for_current_review))
      ? 'routes_pending_review' : hydrated.length ? 'cases_without_usable_source' : 'no_eligible_case',
    strategy: 'bounded_offline_lexical_recall_then_actual_host_semantic_comparison', routes: hydrated, coverage,
    comparisons, package_linkage_skips: packageLinkageSkips,
    availability_filter: { package_linked_only: config.packageLinkedOnly === true,
      review_linked_only: config.reviewLinkedOnly === true, eligibility_is_metadata_only: true,
      skips_are_not_semantic_rejections_or_material_approvals: true },
    source_format_policy: { ...recalled.source_format_policy, story_hard_exclusions_preserved: true },
    gaps: coverage.flatMap(row => row.gaps.map(gap => ({ cue_id: row.cue_id, gap }))),
    formal_adoption_allowed: false, artistic_approval: false, production_approval: false };
  await saveJson(path.join(config.output_dir, 'case-routes.json'), result); return result;
}
