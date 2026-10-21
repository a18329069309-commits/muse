import { objectSchema, validateSchema, readJson, verifyEvidenceBindings } from './audio_api.mjs';
import path from 'node:path';
import { allowsBoundDirectionExecutionBasis } from './bound_direction_execution_evidence.mjs';
import { vocalLanguageMatches } from './vocal_language_policy.mjs';
export { vocalLanguageMatches, directionRoutePolicyGaps } from './vocal_language_policy.mjs';

const str = { type: 'string' }, strings = { type: 'array', items: str };
const rangeSchema = { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 };
const range = x => Array.isArray(x) && x.length === 2 && x.every(Number.isFinite) && x[0] >= 0 && x[1] > x[0];
const inside = (x, outer) => range(x) && range(outer) && x[0] >= outer[0] && x[1] <= outer[1];
const same = (a, b) => range(a) && range(b) && a.every((x, i) => Math.round(x * 48000) === Math.round(b[i] * 48000));
const sampleLength = x => Math.round(x[1] * 48000) - Math.round(x[0] * 48000);
const text = x => typeof x === 'string' && !!x.trim();
const uncertaintyDispositionSchema = objectSchema({ origin: { type: 'string', enum: ['analysis', 'direction'] },
  uncertainty_index: { type: 'integer', minimum: 0 }, original_text: str, source_video_sha256: str,
  components: { type: 'array', minItems: 1, items: objectSchema({ text: str,
    kind: { type: 'string', enum: ['evidence_gap', 'narrative_constraint', 'deferred_review', 'pending_work'] },
    required_stage: { type: 'string', enum: ['before_specific_edit', 'persistent_narrative_constraint',
      'after_trial_render', 'persistent_provenance_limit', 'material_selection', 'words_selection'] }, reason: str,
    basis: { type: 'array', items: objectSchema({ story_beat_id: str,
      field: { type: 'string', enum: ['perspective', 'new_information', 'expectation_before', 'expectation_after', 'control_change'] },
      quote: str, evidence_ids: strings }) },
    condition_refs: { type: 'array', items: objectSchema({ cue_id: str, relationship: str, threat_resolved: { type: ['boolean', 'null'] } }) },
    retained_constraints: strings }) } });
// Constrain new wire output without changing the historical flat reader or its semantic checks.
// Keep the flat object shape alongside anyOf for the existing local structural validator.
const generationDispositionSchema = structuredClone(uncertaintyDispositionSchema);
const componentSchema = uncertaintyDispositionSchema.properties.components.items;
generationDispositionSchema.properties.components.items = { ...structuredClone(componentSchema), anyOf: [
  ['evidence_gap', ['before_specific_edit']],
  ['narrative_constraint', ['persistent_narrative_constraint']],
  ['deferred_review', ['after_trial_render', 'persistent_provenance_limit']],
  ['pending_work', ['material_selection', 'words_selection']],
].map(([kind, stages]) => objectSchema({ ...structuredClone(componentSchema.properties),
  kind: { type: 'string', enum: [kind] }, required_stage: { type: 'string', enum: stages } })) };
// A legacy fixed words window was mandatory before request modes were introduced.
export const wordRequestMode = cue => cue.words_candidate_request ?? (range(cue.words_target_range) ? 'require' : null);
export const requestedWords = cue => ['explore', 'require'].includes(wordRequestMode(cue))
  && (range(cue.words_target_range) || !!cue.words_opportunity);
export const wordIntervals = cue => cue.words_opportunity?.allowed_target_intervals ?? (range(cue.words_target_range) ? [cue.words_target_range] : []);

export const directionSemanticsInstruction = '先统筹整集声音发展，再按真实剧情转折安排cue；容量分区、25秒音窗、16秒拼图都不是换曲边界。'
  + '返回direction_version=2、global_route_summary；每个非首cue用boundary_events引用真实beat、证据和本片边界秒点说明剧情原因。'
  + '原分析uncertainties保留在绑定analysis中，以uncertainty_scopes逐项引用analysis索引、受影响cue/event及影响域；不要复制到direction.uncertainties。'
  + 'direction.uncertainties只记录新增未知，并为其提供direction索引范围；不把剧情未知改称声音未知。'
  + '每个origin+uncertainty_index恰一个scope；一条原句涉及多域时用impact=mixed及逐字拼回的components，不重复索引。'
  + '必须返回uncertainty_dispositions数组；未提出任何处置时返回[]，不由空数组解除未知项。处置须绑定原索引、原句和源SHA，components原样拼回整句。证据缺口保留evidence_gap；'
  + '叙事故意未揭的信息差须引用实际beat原文、帧及不变的关系/危险条件；不能把未看清或未核音误称悬念。'
  + '只有辅助试配可延后after_trial_render或persistent_provenance_limit，素材、唱词及其他前置缺口不能延后。混合句任一缺口未解仍阻断。'
  + '辅助试配在当前尚未执行选材工序时，用pending_work显式绑定真实cue、原句/索引/源SHA与实际剧情basis；required_stage仅material_selection或words_selection。'
  + '这是执行待办，不能宣称无素材、已选曲、已核完整歌句或已通过艺术判断；对应真实检索/比较/编译未执行仍pending。require歌句与来源门不豁免，explore缺口走既有扩大检索和待审机制。'
  + '冻结供给摘要只说明库内有可核包，尚未为本片召回或采用；不能因暂无已核歌句默默取消prefer/英语或其它合适语种的比较。'
  + 'original_sound只引用实际physical/foley/ambience事件；dramatic/transition是新声音设计，不凭画面归成已有物理声。'
  + '原混音组成、已有音乐或总体对白听核限制使用original_mix，event_ids=[]，按实际受影响cue保存；不能为这种限制编造物理事件。original_mix不批准任何声音事实或素材，不解除新增物理同步、歌句或局部对白核验要求。'
  + '保原音且不新增物理hit时，未听原声/粗VAD限制可按实据保留为persistent_provenance_limit或after_trial_render，不签声音事实；真正需新增物理硬同步仍保留before_specific_edit缺口。'
  + '完整歌句先设words_opportunity.allowed_target_intervals和实际story beat锚点，words_target_range=null；require必须采用，explore必须真实比较。'
  + '用户未限定歌唱语种时vocal_language=unknown，按剧情比较各语种已核歌句；明确指定的语种必须保持，实际素材语言未知不能采用。'
  + '机会区间按剧情允许完整歌句发展的范围规划，不应预先缩成VAD静音小缝；选定实际歌句后默认避让对白。显式辅助叠唱试听仍须逐条评估相交对白和待混音听核。'
  + '歌句尚未选定时不指定其精确长度。未知原片动作声只影响对应音效决定，不能声称已经听过。';

export function withDirectionSemanticsV2(schema, { forGeneration = true } = {}) {
  const result = structuredClone(schema);
  Object.assign(result.properties, {
    direction_version: { type: 'integer', enum: [2] }, global_route_summary: str,
    boundary_events: { type: 'array', items: objectSchema({ cue_id: str, story_beat_id: str,
      target_seconds: { type: 'number' }, evidence_ids: strings, reason: str }) },
    uncertainty_scopes: { type: 'array', items: objectSchema({ origin: { type: 'string', enum: ['analysis', 'direction'] },
      uncertainty_index: { type: 'integer', minimum: 0 }, impact: { type: 'string', enum: ['story', 'music', 'words', 'original_sound', 'original_mix', 'mixed'] },
      cue_ids: strings, event_ids: strings }) },
    // Required in strict generation; explicit legacy reads keep their original blocking behavior.
    uncertainty_dispositions: { type: 'array', items: forGeneration ? generationDispositionSchema : uncertaintyDispositionSchema },
  });
  result.required.push('direction_version', 'global_route_summary', 'boundary_events', 'uncertainty_scopes');
  if (forGeneration) result.required.push('uncertainty_dispositions');
  const cue = result.properties.cues.items;
  cue.properties.words_opportunity = { ...objectSchema({ allowed_target_intervals: { type: 'array', items: rangeSchema, minItems: 1 },
    anchor_event_ids: strings }), type: ['object', 'null'] };
  cue.required.push('words_opportunity');
  return result;
}

export function directionSemanticGaps(direction, analysis) {
  if (direction.direction_version !== 2) return [];
  const gaps = [], beats = analysis.story_beats ?? [], cues = direction.cues ?? [];
  if (!text(direction.global_route_summary)) gaps.push('global_sound_route_required');
  for (const [index, cue] of cues.entries()) {
    if (index) {
      const rows = (direction.boundary_events ?? []).filter(x => x.cue_id === cue.cue_id), item = rows[0];
      const beat = beats.find(x => x.id === item?.story_beat_id);
      if (rows.length !== 1 || !beat || !text(item.reason) || !Number.isFinite(item.target_seconds)
        || Math.abs(item.target_seconds - cue.target_range[0]) > 1 / 48000
        || item.target_seconds < beat.start_seconds || item.target_seconds > beat.end_seconds
        || !item.evidence_ids?.length || item.evidence_ids.some(id => !beat.evidence_ids.includes(id)))
        gaps.push('story_boundary_evidence_required:' + cue.cue_id);
    }
    if (cue.words_opportunity) {
      if (!['explore', 'require'].includes(cue.words_candidate_request) || !wordIntervals(cue).length
        || wordIntervals(cue).some(x => !inside(x, cue.target_range)) || !cue.words_opportunity.anchor_event_ids?.length
        || cue.words_opportunity.anchor_event_ids.some(id => !beats.some(b => b.id === id)))
        gaps.push('words_opportunity_outside_story:' + cue.cue_id);
    } else if (['explore', 'require'].includes(cue.words_candidate_request) && !range(cue.words_target_range))
      gaps.push('words_opportunity_required:' + cue.cue_id);
  }
  if ((direction.boundary_events ?? []).some(x => !cues.slice(1).some(c => c.cue_id === x.cue_id)))
    gaps.push('unknown_story_boundary_cue');
  return gaps;
}

function checkedDisposition(disposition, row, scope, direction, analysis, { mode, executionBasis } = {}) {
  validateSchema(disposition, uncertaintyDispositionSchema, 'uncertainty_disposition');
  if (!scope || disposition.original_text !== row.text || !/^[a-f0-9]{64}$/.test(analysis.source_video_sha256)
    || disposition.source_video_sha256 !== analysis.source_video_sha256
    || disposition.components.map(part => part.text).join('') !== row.text)
    throw new Error('direction_uncertainty_disposition_identity_required');
  for (const [componentIndex, part] of disposition.components.entries()) {
    if (!text(part.text) || !text(part.reason)) throw new Error('direction_uncertainty_component_reason_required');
    if (part.kind === 'evidence_gap') {
      if (part.required_stage !== 'before_specific_edit') throw new Error('direction_evidence_gap_cannot_be_deferred');
      continue;
    }
    const assistedOriginalMix = mode === 'assisted_trial' && scope.impact === 'original_mix';
    if (part.kind === 'narrative_constraint' && (!['story', 'mixed'].includes(scope.impact) || part.required_stage !== 'persistent_narrative_constraint')
      || part.kind === 'deferred_review' && (!['music', 'mixed'].includes(scope.impact) && !assistedOriginalMix
        || !['after_trial_render', 'persistent_provenance_limit'].includes(part.required_stage)))
      throw new Error('direction_uncertainty_disposition_scope_or_stage_invalid');
    if (part.kind === 'pending_work' && (!['music', 'words', 'mixed'].includes(scope.impact)
      || !['material_selection', 'words_selection'].includes(part.required_stage)
      || part.required_stage === 'words_selection' && scope.cue_ids.some(id => !requestedWords(direction.cues.find(cue => cue.cue_id === id)))))
      throw new Error('direction_pending_work_stage_or_cue_invalid');
    const executionBound = allowsBoundDirectionExecutionBasis(executionBasis, { sourceSha: analysis.source_video_sha256,
      origin: row.origin, uncertainty_index: row.uncertainty_index, component_index: componentIndex, component: part, scope, mode });
    if (!part.basis.length && !executionBound || !part.retained_constraints.length || part.retained_constraints.some(value => !text(value))
      || part.condition_refs.length !== scope.cue_ids.length
      || new Set(part.condition_refs.map(ref => ref.cue_id)).size !== part.condition_refs.length)
      throw new Error('direction_uncertainty_bound_basis_and_conditions_required');
    for (const ref of part.condition_refs) {
      const cue = direction.cues.find(item => item.cue_id === ref.cue_id), conditions = cue?.case_conditions;
      if (!scope.cue_ids.includes(ref.cue_id) || !text(conditions?.relationship) || conditions.relationship === 'unknown'
        || conditions.relationship !== ref.relationship
        || (conditions.threat_resolved !== null && typeof conditions.threat_resolved !== 'boolean')
        || conditions.threat_resolved !== ref.threat_resolved)
        throw new Error('direction_uncertainty_conditions_changed_or_unverified');
    }
    for (const basis of part.basis) {
      const beat = analysis.story_beats?.find(item => item.id === basis.story_beat_id);
      if (!beat || !text(basis.quote) || !beat[basis.field]?.includes(basis.quote) || !basis.evidence_ids.length
        || basis.evidence_ids.some(id => !beat.evidence_ids?.includes(id))
        || !scope.cue_ids.some(id => { const cue = direction.cues.find(item => item.cue_id === id);
          return beat.start_seconds < cue.target_range[1] && beat.end_seconds > cue.target_range[0]; }))
        throw new Error('direction_uncertainty_actual_story_basis_required');
    }
    if (!executionBound && scope.cue_ids.some(id => { const cue = direction.cues.find(item => item.cue_id === id);
      return !part.basis.some(basis => { const beat = analysis.story_beats.find(item => item.id === basis.story_beat_id);
        return beat.start_seconds < cue.target_range[1] && beat.end_seconds > cue.target_range[0]; }); }))
      throw new Error('direction_uncertainty_actual_story_basis_required');
  }
  return disposition;
}

// Legacy strings remain intact; explicit dispositions only localize assisted-trial work.
export function inspectDirectionUncertainties(direction, analysis, { mode, executionBasis } = {}) {
  const rows = ['analysis', 'direction'].flatMap(origin => (origin === 'analysis' ? analysis : direction).uncertainties?.map((value, i) =>
    ({ origin, uncertainty_index: i, text: value })) ?? []);
  const scopes = direction.direction_version === 2 ? direction.uncertainty_scopes ?? [] : [];
  const seen = new Set(), blocking = [], sound_pending = [], narrative_constraints = [], deferred_review = [], pending_work = [];
  for (const scope of scopes) {
    const key = scope.origin + ':' + scope.uncertainty_index;
    if (seen.has(key) || !rows.some(x => x.origin === scope.origin && x.uncertainty_index === scope.uncertainty_index)
      || !['story', 'music', 'words', 'original_sound', 'original_mix', 'mixed'].includes(scope.impact)
      || !scope.cue_ids?.length || scope.cue_ids.some(id => !direction.cues.some(c => c.cue_id === id))
      || !Array.isArray(scope.event_ids) || scope.event_ids.some(id => !analysis.sound_events?.some(e => e.id === id)))
      throw new Error('direction_uncertainty_scope_invalid');
    if (scope.impact === 'original_sound' && (!scope.event_ids.length || scope.event_ids.some(id =>
      !analysis.sound_events.some(e => e.id === id && ['physical', 'foley', 'ambience'].includes(e.role)
        && scope.cue_ids.some(cueId => { const c = direction.cues.find(cue => cue.cue_id === cueId);
          return e.start_seconds < c.target_range[1] && e.end_seconds > c.target_range[0]; })))))
      throw new Error('direction_uncertainty_scope_original_event_required');
    if (scope.impact === 'original_mix' && scope.event_ids.length)
      throw new Error('direction_uncertainty_mix_cannot_claim_event_scope');
    seen.add(key);
  }
  const dispositions = new Map();
  for (const disposition of direction.uncertainty_dispositions ?? []) {
    const key = disposition.origin + ':' + disposition.uncertainty_index;
    const row = rows.find(item => item.origin === disposition.origin && item.uncertainty_index === disposition.uncertainty_index);
    if (!row || dispositions.has(key)) throw new Error('direction_uncertainty_disposition_index_or_duplicate');
    const scope = scopes.find(item => item.origin === row.origin && item.uncertainty_index === row.uncertainty_index);
    dispositions.set(key, checkedDisposition(disposition, row, scope, direction, analysis, { mode, executionBasis }));
  }
  for (const row of rows) {
    const scope = scopes.find(x => x.origin === row.origin && x.uncertainty_index === row.uncertainty_index);
    const item = { ...row, ...(scope ?? { impact: 'unscoped', cue_ids: direction.cues.map(x => x.cue_id), event_ids: [] }) };
    const disposition = dispositions.get(row.origin + ':' + row.uncertainty_index);
    if (mode === 'assisted_trial' && disposition) {
      for (const [index, part] of disposition.components.entries()) if (part.kind === 'pending_work') pending_work.push({
        work_id: `${row.origin}/${row.uncertainty_index}/${index}`, origin: row.origin, uncertainty_index: row.uncertainty_index,
        original_text: row.text, text: part.text, source_video_sha256: disposition.source_video_sha256,
        cue_ids: scope.cue_ids, required_stage: part.required_stage, basis: part.basis, condition_refs: part.condition_refs,
        words_request_modes: part.required_stage === 'words_selection'
          ? Object.fromEntries(scope.cue_ids.map(id => [id, wordRequestMode(direction.cues.find(cue => cue.cue_id === id))])) : {},
        retained_constraints: part.retained_constraints, status: 'pending_stage_execution',
        qualification_granted: false, factual_approval: false, production_approval: false });
    }
    if (mode === 'assisted_trial' && disposition && disposition.components.every(part => part.kind !== 'evidence_gap')) {
      const pending = { ...item, disposition, status: 'unresolved_constraint_not_factual_approval', qualification_granted: false };
      // Deferred review never erases the unheard original mix or approves a new physical edit.
      if (scope.impact === 'original_mix') sound_pending.push(pending);
      if (disposition.components.some(part => part.kind === 'narrative_constraint')) narrative_constraints.push(pending);
      if (disposition.components.some(part => part.kind === 'deferred_review')) deferred_review.push(pending);
      continue;
    }
    (['original_sound', 'original_mix'].includes(scope?.impact) ? sound_pending : blocking).push(item);
  }
  return { blocking, sound_pending, narrative_constraints, deferred_review, pending_work, all: rows, qualification_granted: false };
}

// Only the consumer supplies completed cue IDs after the actual stage and its existing checks have run.
export function resolveDirectionPendingWork(work, { stage, evidence, completed_cue_ids = [], exploration_gap_cue_ids = [] }) {
  if (!['material_selection', 'words_selection'].includes(stage) || !text(evidence?.path)
    || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') || stage !== 'words_selection' && exploration_gap_cue_ids.length)
    throw new Error('direction_pending_work_stage_evidence_required');
  return work.map(item => {
    if (item.status !== 'pending_stage_execution' || item.required_stage !== stage) return item;
    const complete = item.cue_ids.every(id => completed_cue_ids.includes(id));
    const retained = item.cue_ids.every(id => completed_cue_ids.includes(id)
      || item.words_request_modes?.[id] === 'explore' && exploration_gap_cue_ids.includes(id));
    if (!complete && !retained) return item;
    return { ...item, status: complete ? 'completed_stage_not_factual_approval' : 'exploration_gap_retained',
      stage_evidence: evidence, factual_approval: false, qualification_granted: false, production_approval: false };
  });
}

const canonicalDirection = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
export function assertDirectionRepairFieldsUnchanged(previous, value) {
  const fields = new Set([...Object.keys(previous), ...Object.keys(value)]);
  for (const field of fields) if (!['uncertainty_scopes', 'uncertainty_dispositions'].includes(field)
    && canonicalDirection(previous[field]) !== canonicalDirection(value[field]))
    throw new Error('direction_semantic_repair_changed_frozen_field');
}

// A new failure recheck binds the old immutable outcome. It never relabels an old CLI response.
export async function loadDirectionSemanticRepair(repair, { sourceSha, analysis }) {
  await verifyEvidenceBindings([repair.previous_direction, repair.error_evidence]);
  const prior = await readJson(repair.previous_direction.path), error = await readJson(repair.error_evidence.path);
  if (error.schema_version !== 1 || error.kind !== 'bound_direction_semantic_failure_recheck'
    || error.status !== 'semantic_invalid' || error.source_video_sha256 !== sourceSha
    || error.previous_direction?.sha256 !== repair.previous_direction.sha256
    || !/^[a-z0-9_]{1,160}$/.test(error.error ?? '')) throw new Error('direction_semantic_repair_error_binding_required');
  await verifyEvidenceBindings([error.previous_direction, error.original_failure_record, error.request, error.receipt, error.analysis,
    ...(error.response ? [error.response] : [])]);
  const failure = await readJson(error.original_failure_record.path), request = await readJson(error.request.path),
    receipt = await readJson(error.receipt.path), originalAnalysis = await readJson(error.analysis.path);
  if (failure.research_story?.analysis_result?.sha256 !== error.analysis.sha256)
    throw new Error('direction_semantic_repair_original_analysis_mismatch');
  await verifyEvidenceBindings(failure.research_story.analysis_result);
  let requestedAnalysis = request.input?.data?.analysis;
  if (request.input?.data?.completed_story) {
    if (request.input.data.completed_story.sha256 !== failure.research_story.response?.sha256)
      throw new Error('direction_semantic_repair_original_analysis_mismatch');
    await verifyEvidenceBindings(request.input.data.completed_story);
    const story = await readJson(request.input.data.completed_story.path);
    requestedAnalysis = story.value ?? story;
  }
  if (canonicalDirection(requestedAnalysis) !== canonicalDirection(originalAnalysis))
    throw new Error('direction_semantic_repair_original_analysis_mismatch');
  const relative = path.relative(path.dirname(error.original_failure_record.path), repair.previous_direction.path);
  if (relative.startsWith('..') || path.isAbsolute(relative) || failure.status !== 'failed' || failure.error !== error.error
    || failure.source_video_sha256 !== sourceSha || request.role !== 'director'
    || request.input?.stage !== 'research_style_director' || request.source_video_sha256 !== sourceSha
    || receipt.source_video_sha256 !== sourceSha || receipt.final?.sha256 !== repair.previous_direction.sha256
    || receipt.request?.sha256 !== error.request.sha256 || !['complete', 'semantic_invalid'].includes(receipt.status)
    || canonicalDirection(originalAnalysis) !== canonicalDirection(analysis))
    throw new Error('direction_semantic_repair_closed_outcome_mismatch');
  const previous = prior.value ?? prior;
  if (receipt.status === 'complete') {
    if (!error.response) throw new Error('direction_semantic_repair_original_response_required');
    const response = await readJson(error.response.path);
    if (response.request_sha256 !== receipt.request_sha256 || response.source_video_sha256 !== sourceSha
      || response.completion_status !== 'complete' || !response.cli_receipts?.some(item => item.sha256 === error.receipt.sha256)
      || !response.evidence_files?.some(item => item.sha256 === error.request.sha256)
      || canonicalDirection(response.value) !== canonicalDirection(previous))
      throw new Error('direction_semantic_repair_original_response_mismatch');
  } else if (receipt.detail !== error.error) throw new Error('direction_semantic_repair_original_response_mismatch');
  let replayed = null;
  try { inspectDirectionUncertainties(previous, originalAnalysis, { mode: 'assisted_trial' }); }
  catch (cause) { replayed = cause.message; }
  if (replayed !== error.error) throw new Error('direction_semantic_repair_failure_not_reproduced');
  return { ...repair, previous_value: previous, error_summary: error.error };
}

export function buildLyricRecallDirector(director) {
  return { ...director, cues: director.cues.flatMap(cue => [structuredClone(cue), ...(requestedWords(cue) ? [{
    ...structuredClone(cue), cue_id: cue.cue_id + '/words', parent_cue_id: cue.cue_id,
    music_role: 'words_candidate', audio_retrieval_query: cue.words_audio_retrieval_query,
    // This is story context for retrieval, never a requested phrase duration.
    target_range: [...cue.target_range], words_recall_duration_policy: 'complete_phrase_before_placement',
  }] : [])]) };
}

const overlap = (a, b) => a[0] < b[1] && a[1] > b[0];
export function resolveWordDecisions({ director, candidates, decisions, dialogueIntervals = [],
  mode, dialoguePolicy = 'avoid', dialogueEvidence = [] }) {
  const output = structuredClone(director), chosen = [], comparisons = [], gaps = [], overlapTrials = [];
  const tasks = director.cues.filter(requestedWords), supplied = tasks.filter(cue => candidates.some(c => c.cue_id === cue.cue_id + '/words'));
  if (decisions.length !== supplied.length || new Set(decisions.map(x => x.cue_id)).size !== decisions.length
    || decisions.some(x => !supplied.some(cue => x.cue_id === cue.cue_id + '/words')))
    throw new Error('assisted_exact_words_comparisons_required');
  for (const cue of tasks) {
    const id = cue.cue_id + '/words', pool = candidates.filter(x => x.cue_id === id);
    const decision = decisions.find(x => x.cue_id === id), current = output.cues.find(x => x.cue_id === cue.cue_id);
    const fail = (reason, fields = {}) => {
      const gap = { cue_id: id, reason, requested_mode: wordRequestMode(cue), blocks_render: true, ...fields };
      gaps.push(gap); comparisons.push({ ...gap, status: 'unresolved', decision: decision ?? null });
    };
    if (!pool.length) {
      const required = wordRequestMode(cue) === 'require';
      fail('no_reviewed_complete_lyric_candidate', { blocks_render: required, comparison_status: 'material_missing_not_rejected',
        execution_action: required ? 'required_phrase_pending' : 'deferred_for_preview_only' });
      if (!required) {
        // Only the execution copy loses this optional task; the original proposal and unresolved receipt remain.
        current.words_candidate_request = null; current.words_target_range = null; current.words_opportunity = null;
      }
      continue;
    }
    if (!decision.selected_segment_id) {
      const complete = text(decision.reason) && pool.every(candidate => decision.rejected.some(row =>
        row.segment_id === candidate.segment_id && row.source_sha256 === candidate.source_sha256
        && same(row.source_range, candidate.source_range) && text(row.reason)
        && ['lyrics_semantics', 'dialogue_conflict', 'style_conflict'].includes(row.conflict_kind)));
      if (!complete) { fail('actual_per_window_lyrics_conflict_required'); continue; }
      comparisons.push({ cue_id: id, status: 'compared_rejected', decision });
      if (wordRequestMode(cue) === 'require') { gaps.push({ cue_id: id, reason: 'required_complete_lyric_phrase_not_selected',
        requested_mode: 'require', blocks_render: true }); continue; }
      current.words_candidate_request = null; current.words_target_range = null; current.words_opportunity = null;
      continue;
    }
    const target = director.direction_version === 2 ? decision.selected_target_range : cue.words_target_range;
    const matches = pool.filter(x => x.segment_id === decision.selected_segment_id && inside(decision.selected_source_range, x.source_range)
      && (!x.allowed_target_range || inside(target, x.allowed_target_range)));
    const candidate = matches[0], phrase = candidate?.offline_observation?.words;
    const intervals = dialogueIntervals.map(x => Array.isArray(x) ? x : [x.start_seconds, x.end_seconds]);
    if (intervals.some(x => !range(x))) throw new Error('assisted_dialogue_intervals_invalid');
    if (matches.length !== 1 || !phrase?.complete_phrase || !vocalLanguageMatches(cue.vocal_language, phrase.vocal_language)
      || candidate.offline_observation.music_form !== 'short_lyrics' || !text(phrase.actual_words)
      || !same(decision.selected_source_range, phrase.source_range) || !wordIntervals(cue).some(x => inside(target, x))
      || sampleLength(target) !== sampleLength(phrase.source_range)) { fail('complete_phrase_placement_or_dialogue_conflict'); continue; }
    const intersections = intervals.filter(x => overlap(x, target)).map(x => [Math.max(x[0], target[0]), Math.min(x[1], target[1])]);
    let trial = null;
    if (intersections.length) {
      const proposal = decision.dialogue_overlap_proposal;
      if (mode !== 'assisted_trial' || dialoguePolicy !== 'trial_overlap' || !proposal) {
        fail('complete_phrase_placement_or_dialogue_conflict'); continue;
      }
      const evidence = dialogueEvidence.filter(x => range(x.source_range) && intersections.some(r => overlap(r, x.source_range)));
      const valid = evidence.length && evidence.every(x => text(x.id) && text(x.text) && text(x.binding?.path)
        && /^[a-f0-9]{64}$/.test(x.binding?.sha256) && /^[a-f0-9]{64}$/.test(director.source_video_sha256)
        && x.source_video_sha256 === director.source_video_sha256);
      const covered = intersections.every(r => {
        let end = r[0];
        for (const x of evidence.map(x => x.source_range).sort((a, b) => a[0] - b[0])) {
          if (x[0] > end) break; if (x[1] > end) end = x[1];
        }
        return end >= r[1];
      });
      const assessments = proposal.dialogue_assessments ?? [];
      if (!valid || !covered || assessments.length !== evidence.length || new Set(assessments.map(x => x.evidence_id)).size !== evidence.length
        || evidence.some(x => !assessments.some(a => a.evidence_id === x.id && text(a.reason)))
        || !text(proposal.semantic_reason) || !text(proposal.masking_risk) || !text(proposal.mix_instruction)) {
        fail('overlap_trial_bound_dialogue_and_risk_required'); continue;
      }
      if (assessments.some(x => x.importance !== 'noncritical') || dialogueIntervals.some((x, i) =>
        x?.importance === 'critical' && overlap(intervals[i], target))) {
        fail('overlap_trial_critical_or_unknown_dialogue_protected'); continue;
      }
      // This is a rendering experiment, never an approval of intelligibility or the current mix.
      trial = { cue_id: id, status: 'pending_actual_mix_audition', source_video_sha256: director.source_video_sha256,
        source_sha256: candidate.source_sha256, source_range: [...phrase.source_range], actual_words: phrase.actual_words,
        target_range: [...target], dialogue_intersections: intersections, dialogue_evidence: evidence, proposal,
        human_review_record: candidate.offline_observation.human_review_record ?? candidate.human_review_record ?? null,
        required_review: 'current_audiovisual_mix_intelligibility_and_semantic_fit',
        dialogue_importance_basis: 'director_proposal_not_verified_sound_fact', formal_adoption_allowed: false, production_approval: false };
      overlapTrials.push(trial);
    }
    current.words_target_range = [...target]; current.vocal_language = phrase.vocal_language; delete current.words_opportunity;
    comparisons.push({ cue_id: id, status: trial ? 'selected_overlap_trial_pending_audition' : 'selected_complete_phrase', decision, target_range: target,
      requested_vocal_language: cue.vocal_language, selected_vocal_language: phrase.vocal_language });
    chosen.push({ ...candidate, source_range: [...phrase.source_range], target_range: [...target], parent_cue_id: cue.cue_id,
      ...(trial ? { dialogue_overlap_trial: trial } : {}) });
  }
  return { director: output, chosen, comparisons, gaps, overlap_trials: overlapTrials };
}
