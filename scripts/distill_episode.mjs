import { mkdir, readdir, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareEpisode } from './prepare_episode.mjs';
import { prepareReviewWindow } from './prepare_review_window.mjs';
import { ApiSession, objectSchema, prepareApiAudio, providerReadiness, readJson, saveJson, shaBytes, validateSchema,
  resolveAudioBackend, audioBackendMatches, validateAudioQualification, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const str = { type: 'string' }, num = { type: 'number' };
const strings = { type: 'array', items: str };
const range = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const list = (items, maxItems = 20) => ({ type: 'array', items, maxItems });
const conditionsSchema = objectSchema(Object.fromEntries([
  'narrative_function', 'perspective', 'relationship', 'control_state', 'control_change',
  'expectation_state', 'era', 'dialogue_density', 'knowledge_state',
].map(key => [key, { type: ['string', 'null'] }]).concat([
  ['threat_resolved', { type: ['boolean', 'null'] }],
])));
export const distillationSchema = objectSchema({ source_video_sha256: str,
  cases: list(objectSchema({ local_id: str, source_range: range, description: str,
    observation_ids: strings, conditions: conditionsSchema,
    story_sequence: list(objectSchema({ step_id: str, narrative_function: str,
      before: conditionsSchema, after: conditionsSchema })),
    source_events: list(objectSchema({ event_id: str, source_range: range, description: str,
      kind: { type: 'string', enum: ['story', 'music', 'physical', 'dramatic', 'transition', 'ambience'] }, observation_ids: strings })),
    development_preset: objectSchema({ steps: list(objectSchema({ step_id: str,
      story_step_id: str, source_event_id: str, action: str, anchor: str, offset_seconds: num, development_description: str })) }),
    sound_actions: list(objectSchema({ anchor: str, action: str, offset_seconds: num })),
    music_observations: list(objectSchema({ source_range: range, entry_role: str, development: str,
      exit_role: str, sung_words: str, words_function: str, unknowns: strings })),
    sound_effects: list(objectSchema({ source_range: range,
      sound_role: { type: 'string', enum: ['physical', 'dramatic', 'transition', 'ambience'] },
      actual_sound: str, narrative_function: str, physical_evidence: str, unknowns: strings })),
    uncertainties: strings }), 256), uncertainties: strings });

export function distillationSchemaForObservations(observations) {
  const ids = observations.map(row => row.observation_id);
  if (!ids.length || ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
    throw new Error('actual_observation_ids_required');
  const schema = structuredClone(distillationSchema);
  const properties = schema.properties.cases.items.properties;
  properties.observation_ids = { type: 'array', items: { type: 'string', enum: [...ids] } };
  properties.source_events.items.properties.observation_ids = { type: 'array', items: { type: 'string', enum: [...ids] } };
  return schema;
}

const prompt = '你是短剧声音案例研究导演。依据本次实际提交的带时间码画面和原音频观察证据，'
  + '分类人物视角、关系、观众知情、主动权、未决威胁和期待变化。未接收原音频或连续视频时不得声称亲自听到或看到。'
  + '本地ASR和声音分类器预测不是已核实声音事实；不可据此编造乐器、歌句或原配乐变化。未知声音明确写unknown，预设建议与观察分开。'
  + '不要按字幕关键词、表情或切镜给情绪标签；切镜本身不是音乐事件。'
  + '每case给入段状态→改变→出段状态的有序story_sequence，发展预设逐步绑定story_step_id和相对事件anchor。'
  + 'source_events记录事件真实源视频时间区间和实际观察ID；每个发展步骤source_event_id必须引用本case事件，不能只给任意anchor名字。'
  + '区分音乐进入、蓄势、声部/节奏发展、释放、保留与退出；增大音量不等于编配发展。'
  + '说明歌句实际可闻内容、谁对谁说、剧情作用与对白竞争；听不清写unknown，不按发行信息猜唱词。'
  + '音效区分物理、剧情强调、转场、环境，物理声给画面接触依据；不把混合参考音当干净素材。'
  + 'condition未知填null，threat_resolved只能boolean/null。local_id只标识当前案例，'
  + '不返回素材路径、曲名推测、音乐pack、主题版本、许可或approved。'
  + '所有source_range使用完整视频零点，observation_ids必须绑定覆盖该窗口的实际观察ID。'
  + '所有case、source_event、music_observation和sound_effect的source_range都必须是正长度区间，终点严格大于起点，且包含在本case内。'
  + '瞬间动作的anchor可写在描述中；source_range表示实际观察到该动作的上下文区间，禁止写[t,t]。若帧采样不足以确定动作持续时间，明确记录未知，不编造精确时长。'
  + 'case和source_event的observation_ids只能使用输入audio_observations中的ID；frame_*是视觉帧引用，禁止填入observation_ids。'
  + 'cases合起来覆盖整集时间轴，包括未知或过渡区间；不能用几个亮点代替全片分析。'
  + '参考声音未知来源保留缺口，记录观察不能签发本集选曲或用户审美通过。';

const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const validRange = (value, duration) => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && value[0] >= 0 && value[1] > value[0] && value[1] <= duration + 1 / 48000;
const known = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== 'unknown'));
const exists = async file => { try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const signature = value => shaBytes(JSON.stringify(value));
async function currentBindings(value) {
  const files = [];
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (typeof item.path === 'string' && typeof item.sha256 === 'string') files.push(item);
    for (const child of Object.values(item)) visit(child);
  };
  visit(value);
  for (const file of files) {
    try { if (await hashFile(file.path) !== file.sha256) return false; } catch { return false; }
  }
  return true;
}

async function openCheckpoint(config) {
  const root = path.resolve(config.output_dir), checkpointRoot = path.resolve(config.checkpoint_dir ?? root);
  const file = path.join(checkpointRoot, 'distillation-state.json');
  const identity = { work_id: config.work_id, episode_id: config.episode_id, split: config.split ?? 'research',
    official_series_id: config.official_series_id ?? null, identity_aliases: [...(config.identity_aliases ?? [])].sort() };
  let state;
  if (await exists(file)) {
    state = await readJson(file);
    if (state.schema_version !== 1 || signature(state.identity) !== signature(identity)) throw new Error('distillation_resume_identity_changed');
    if (state.artifact_root && state.artifact_root !== root) throw new Error('distillation_resume_storage_changed');
  } else {
    try { if ((await readdir(root)).length) throw new Error('output_directory_must_be_empty'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    state = { schema_version: 1, identity, attempts: 0, preparations: {}, observations: {}, directors: {}, unknown_outcomes: {} };
  }
  await mkdir(root, { recursive: true });
  await mkdir(checkpointRoot, { recursive: true });
  state.artifact_root = root;
  const out = state.attempts++ === 0 ? root : path.join(root, 'attempts', String(state.attempts));
  const save = async () => {
    await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n', 'utf8');
    await rename(`${file}.tmp`, file);
  };
  await save();
  await mkdir(out, { recursive: true });
  return { root: checkpointRoot, out, state, save };
}

// Trusted preparation callers freeze all derived identities before passing this descriptor.
// An ordinary user-supplied manifest still only locates the source and is rebuilt.
export async function bindPreparedEpisode(filename) {
  const manifest = await readJson(filename), base = path.dirname(path.resolve(filename));
  return { manifest: await bound(filename), source: await bound(path.resolve(base, manifest.source_video)),
    audio: await bound(path.resolve(base, manifest.original_audio)),
    frames: await Promise.all(manifest.frames.map(frame => bound(path.resolve(base, frame.path)))) };
}

export function windowsFor(duration) {
  const windows = [];
  for (let start = 0; start < duration; start += 22) {
    windows.push([start, Math.min(duration, start + 25)]);
    if (start + 25 >= duration) break;
  }
  return windows;
}

export function observationCoverage(duration, planned, completed) {
  const ranges = completed.map(row => row.source_range).sort((a, b) => a[0] - b[0]);
  const missing = []; let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor + 1 / 48000) missing.push([cursor, start]);
    cursor = Math.max(cursor, end);
  }
  if (cursor < duration - 1 / 48000) missing.push([cursor, duration]);
  const completedIds = new Set(completed.map(row => row.observation_id));
  return { duration_seconds: duration, planned_windows: planned.length, completed_windows: completedIds.size,
    processed_ranges: ranges, missing_ranges: missing,
    pending_window_ids: planned.filter(row => !completedIds.has(row.observation_id)).map(row => row.observation_id),
    complete_processed: completedIds.size === planned.length && missing.length === 0,
    sound_semantics_verified: false };
}

async function runtimeResponse(response, sourceSha, sourceRange = null) {
  if (!response?.model?.trim() || response.actual_input_processed !== true || response.completion_status !== 'complete'
    || response.source_video_sha256 !== sourceSha || !response.raw_response?.path
    || sourceRange && JSON.stringify(response.source_range) !== JSON.stringify(sourceRange))
    throw new Error('research_runtime_input_binding_required');
  if (await hashFile(response.raw_response.path) !== response.raw_response.sha256)
    throw new Error('research_runtime_evidence_changed');
  const raw = await readJson(response.raw_response.path);
  if (JSON.stringify(raw.value) !== JSON.stringify(response.value)
    || raw.source_video_sha256 !== sourceSha || raw.model !== response.model || raw.completion_status !== response.completion_status
    || raw.actual_input_processed !== response.actual_input_processed
    || raw.actual_video_processed !== response.actual_video_processed
    || raw.synchronized_video_sha256 !== response.synchronized_video_sha256
    || raw.backend_id !== response.backend_id || raw.model_revision !== response.model_revision
    || JSON.stringify(raw.evidence_files) !== JSON.stringify(response.evidence_files)
    || sourceRange && JSON.stringify(raw.source_range) !== JSON.stringify(sourceRange))
    throw new Error('research_runtime_raw_result_mismatch');
  if (response.evidence_files !== undefined && (!Array.isArray(response.evidence_files)
    || response.evidence_files.some(file => typeof file?.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))))
    throw new Error('research_runtime_evidence_bindings_required');
  await verifyEvidenceBindings(response.evidence_files);
  if (await hashFile(response.raw_response.path) !== response.raw_response.sha256)
    throw new Error('research_runtime_evidence_changed');
  return response;
}

async function recordCliUsage(record, receipts = []) {
  await verifyEvidenceBindings(receipts);
  const calls = await Promise.all(receipts.map(file => readJson(file.path)));
  record.cli_receipts = receipts; record.cli_model_calls = receipts.length;
  record.account_usage = calls.map(row => row.usage ?? null);
  record.cli_submitted_images = calls.reduce((total, row) => total + (row.submitted_image_count ?? 0), 0);
}

function apiBindings(session, out) {
  return (session?.ledger ?? []).flatMap(row => {
    const submitted = { ordinal: row.ordinal, provider: row.provider, model: row.model, stage: row.stage,
      cost_ceiling_usd: row.cost_ceiling_usd, request_body_sha256: row.request_body_sha256, status: 'submitted', usage: null,
      ...(row.backend_id ? { protocol: row.protocol, backend_id: row.backend_id, model_revision: row.model_revision } : {}) };
    const expected = (name, value) => ({ path: path.join(out, 'api', `${row.ordinal}-${name}.json`),
      sha256: shaBytes(JSON.stringify(value, null, 2) + '\n') });
    return [row.response, expected('submission', submitted), expected('receipt', row)];
  });
}

function validateCases(value, sourceSha, duration, observations, deriveParentReferences = false) {
  if (value.source_video_sha256 !== sourceSha) throw new Error('distillation_source_identity_mismatch');
  const ids = new Set(), cases = [], changes = [];
  for (const item of value.cases) {
    if (!item.local_id.trim() || ids.has(item.local_id) || !validRange(item.source_range, duration)) throw new Error('invalid_distillation_case_identity');
    ids.add(item.local_id);
    for (const condition of [item.conditions, ...item.story_sequence.flatMap(step => [step.before, step.after])]) {
      if (Object.values(condition).some(value => typeof value === 'string' && !value.trim())) throw new Error('blank_case_condition');
    }
    if (!item.observation_ids.length || new Set(item.observation_ids).size !== item.observation_ids.length) throw new Error('case_actual_observations_required');
    const used = item.observation_ids.map(id => observations.find(row => row.observation_id === id));
    if (used.some(row => !row)) throw new Error('unknown_case_observation');
    let covered = item.source_range[0];
    for (const row of used.sort((a, b) => a.source_range[0] - b.source_range[0])) {
      if (row.source_range[0] > covered + 1 / 48000) break;
      covered = Math.max(covered, row.source_range[1]);
    }
    if (covered < item.source_range[1] - 1 / 48000) throw new Error('case_outside_actual_observation_coverage');
    const steps = new Map(item.story_sequence.map((step, index) => [step.step_id, index]));
    const events = new Map((item.source_events ?? []).map(event => [event.event_id, event]));
    if (!events.size || events.size !== item.source_events.length) throw new Error('bound_source_events_required');
    const effectiveIds = new Set(item.observation_ids);
    for (const event of events.values()) {
      if (event.source_range[1] <= event.source_range[0]) throw new Error('source_event_range_requires_positive_duration');
      if (!event.event_id.trim() || !validRange(event.source_range, duration)
        || event.source_range[0] < item.source_range[0] || event.source_range[1] > item.source_range[1]
        || !event.observation_ids.length)
        throw new Error('source_event_observation_binding_invalid');
      for (const id of event.observation_ids.filter(id => !item.observation_ids.includes(id))) {
        const row = observations.find(row => row.observation_id === id);
        if (!deriveParentReferences || !row || row.source_range[0] >= event.source_range[1]
          || row.source_range[1] <= event.source_range[0]) throw new Error('source_event_observation_binding_invalid');
        effectiveIds.add(id);
      }
      let end = event.source_range[0];
      for (const row of observations.filter(row => event.observation_ids.includes(row.observation_id)).sort((a, b) => a.source_range[0] - b.source_range[0])) {
        if (row.source_range[0] > end + 1 / 48000) break;
        end = Math.max(end, row.source_range[1]);
      }
      if (end < event.source_range[1] - 1 / 48000) throw new Error('source_event_outside_observation');
    }
    if (!steps.size || steps.size !== item.story_sequence.length
      || item.story_sequence.some(step => !step.step_id.trim() || !step.narrative_function.trim())) throw new Error('ordered_story_steps_required');
    const developmentIds = new Set(); let position = -1;
    for (const step of item.development_preset.steps) {
      const next = steps.get(step.story_step_id);
      if (next === undefined || next < position || !step.step_id.trim() || developmentIds.has(step.step_id)
        || !events.has(step.source_event_id) || !step.action.trim() || !step.anchor.trim()) throw new Error('development_story_binding_invalid');
      developmentIds.add(step.step_id); position = next;
    }
    for (const detail of [...item.music_observations, ...item.sound_effects]) {
      if (detail.source_range[1] <= detail.source_range[0]) throw new Error('sound_observation_range_requires_positive_duration');
      if (!validRange(detail.source_range, duration) || detail.source_range[0] < item.source_range[0]
        || detail.source_range[1] > item.source_range[1]) throw new Error('sound_observation_outside_case');
    }
    if (effectiveIds.size !== item.observation_ids.length) {
      const derivedIds = [...effectiveIds];
      changes.push({ case_local_id: item.local_id, declared_observation_ids: [...item.observation_ids],
        derived_observation_ids: derivedIds, added_references: derivedIds.filter(id => !item.observation_ids.includes(id))
          .map(id => ({ observation_id: id, source_event_ids: item.source_events.filter(event => event.observation_ids.includes(id)).map(event => event.event_id) })) });
      cases.push({ ...item, observation_ids: derivedIds });
    } else cases.push(item);
  }
  return { value: changes.length ? { ...value, cases } : value, changes };
}

// The original parent references must already cover the case; only redundant event references are added.
export function deriveResearchObservationReferences(value, sourceSha, duration, observations) {
  return validateCases(value, sourceSha, duration, observations, true);
}

// Immutable attempt outputs share only verified stage checkpoints.
export async function distillEpisode(config, runtime = {}) {
  if (!config?.work_id?.trim() || !config.episode_id?.trim() || !config.output_dir || (!config.video && !config.manifest)) throw new Error('distillation_episode_inputs_required');
  const mode = config.mode ?? 'verified';
  if (!['research', 'verified'].includes(mode)) throw new Error('invalid_distillation_mode');
  const localRuntime = mode === 'research' && typeof runtime.observer === 'function' && typeof runtime.director === 'function';
  if (localRuntime && (!runtime.observer_backend_id?.trim() || !runtime.director_backend_id?.trim()))
    throw new Error('research_runtime_backend_identity_required');
  const backend = localRuntime ? null : resolveAudioBackend(config.audio_backend);
  const checkpoint = await openCheckpoint(config), { out, state } = checkpoint;
  const record = { schema_version: 1, mode, work_id: config.work_id, episode_id: config.episode_id,
    status: 'preparing', model_calls: 0, cloud_uploads: 0, runtime_calls: 0, actual_audio_processed: false,
    actual_video_processed: false, artistic_approval: false, production_approval: false,
    audio_backend: backend,
    counts: { observation_windows: 0, reused_observation_windows: 0, cases: 0, music_packs: 0, sound_packs: 0 }, gaps: [],
    resume_supported: true, checkpoint_root: checkpoint.root, observation_calls_this_run: 0, director_calls_this_run: 0,
    cli_model_calls: 0, cli_receipts: [], account_usage: [] };
  let session, document; const observations = [], localEvidence = [];
  try {
    // A supplied manifest locates a verified parent video; its derived media and times are untrusted.
    let parentVideo = config.video, declaredParentHash;
    if (config.manifest) {
      const suppliedPath = path.resolve(config.manifest), supplied = await readJson(suppliedPath);
      parentVideo = path.resolve(path.dirname(suppliedPath), supplied.source_video);
      declaredParentHash = supplied.source_sha256;
      record.supplied_manifest = await bound(suppliedPath);
    }
    const parentBinding = await bound(parentVideo);
    if ((declaredParentHash && parentBinding.sha256 !== declaredParentHash)
      || (config.source_video_sha256 && parentBinding.sha256 !== config.source_video_sha256)) throw new Error('source_video_changed');
    record.parent_video = parentBinding;
    if (Object.values(state.preparations).some(item => item.source.sha256 !== parentBinding.sha256))
      throw new Error('distillation_resume_source_changed');
    if (state.unknown_outcomes[parentBinding.sha256]) {
      record.status = 'api_outcome_unknown'; record.gaps = ['previous_api_outcome_unknown']; return record;
    }
    // A source_range on a compilation is not an episode mapping. Require a real episode file.
    if (config.source_range != null) throw new Error('unmapped_source_range_requires_episode_file');
    const preparationKey = signature({ source: parentBinding, step: 2, version: 1 });
    const prepared = state.preparations[preparationKey];
    if (prepared && !await currentBindings(prepared)) throw new Error('cached_preparation_evidence_changed');
    const suppliedPreparation = config.prepared_manifest_binding;
    if (!prepared && suppliedPreparation && (!suppliedPreparation.manifest?.path
      || !await currentBindings(suppliedPreparation)
      || suppliedPreparation.source?.sha256 !== parentBinding.sha256)) throw new Error('prepared_episode_binding_changed');
    const manifestPath = prepared?.manifest.path ?? suppliedPreparation?.manifest.path ?? path.join(out, 'media/manifest.json');
    if (!prepared && !suppliedPreparation) await prepareEpisode({ video: parentVideo, out: path.join(out, 'media'), step: 2 });
    const manifest = await readJson(manifestPath), base = path.dirname(manifestPath);
    if (manifest.analysis_window || manifest.timeline?.sample_rate !== 48000 || !manifest.original_audio
      || !Number.isSafeInteger(manifest.timeline?.duration_samples) || manifest.timeline.duration_samples <= 0
      || !Number.isFinite(manifest.video?.first_pts_seconds) || !manifest.frames?.length) throw new Error('full_aligned_episode_manifest_required');
    const duration = manifest.timeline.duration_samples / 48000;
    const source = path.resolve(base, manifest.source_video), original = path.resolve(base, manifest.original_audio);
    const sourceBinding = await bound(source), audioBinding = await bound(original);
    if (sourceBinding.sha256 !== parentBinding.sha256 || sourceBinding.sha256 !== manifest.source_sha256) throw new Error('source_video_changed');
    if (config.video && path.resolve(config.video) !== source && await hashFile(config.video) !== sourceBinding.sha256) throw new Error('video_and_manifest_source_mismatch');
    record.source_video_sha256 = sourceBinding.sha256;
    record.input_manifest = await bound(manifestPath); record.original_audio = audioBinding;
    const frames = await Promise.all(manifest.frames.map(async (frame, index) => {
      if (!Number.isFinite(frame.timeline_seconds) || frame.timeline_seconds < 0 || frame.timeline_seconds >= duration) throw new Error('manifest_frame_outside_episode');
      return { ...frame, id: `frame_${index + 1}`, ...await bound(path.resolve(base, frame.path)) };
    }));
    if (!prepared && suppliedPreparation && (JSON.stringify(await bindPreparedEpisode(manifestPath)) !== JSON.stringify(suppliedPreparation)))
      throw new Error('prepared_episode_binding_changed');
    if (!prepared) {
      state.preparations[preparationKey] = { source: sourceBinding, manifest: record.input_manifest, audio: audioBinding, frames };
      await checkpoint.save();
    }
    const windows = windowsFor(duration);
    const planned = windows.map((source_range, index) => ({ observation_id: `observation_${index + 1}`, source_range }));
    record.coverage = observationCoverage(duration, planned, observations);
    const task = { schema_version: 2, work_id: config.work_id, episode_id: config.episode_id,
      source_video: sourceBinding, original_audio: audioBinding, manifest: record.input_manifest,
      duration_seconds: duration, mode, audio_backend: backend, windows: planned,
      frames, prompt, response_schema: distillationSchema, status: 'prepared_not_submitted' };
    record.task = await saveJson(path.join(out, 'distillation-task.json'), task);
    document = { schema_version: 2, works: [{ work_id: config.work_id, title: config.title || config.work_id,
      split: config.split || 'research', ...(config.official_source ? { official_source: config.official_source } : {}),
      ...(config.official_series_id ? { official_series_id: config.official_series_id } : {}),
      ...(config.identity_aliases ? { identity_aliases: config.identity_aliases } : {}) }],
    episodes: [{ episode_id: config.episode_id, work_id: config.work_id, media_status: 'acquired',
      source_video: sourceBinding, duration_seconds: duration }], cases: [] };
    const readiness = providerReadiness(config.budget, runtime.environment ?? process.env);
    if (!localRuntime && !readiness.ready) { record.status = 'prepared'; record.gaps = readiness.missing; return record; }
    const qualified = mode === 'verified' ? await validateAudioQualification(config.qualification_file ?? config.qualification,
      backend, ['audio_observation']) : { ready: false };
    if (mode === 'verified' && !qualified.ready) { record.status = 'needs_audio_backend'; record.gaps = ['qualified_audio_observer_required']; return record; }
    const callsNeeded = windows.length + 1;
    if (!localRuntime && (config.budget.max_calls < callsNeeded || config.budget.max_estimated_cost_usd + 1e-9 < callsNeeded * config.budget.per_call_cost_ceiling_usd)) {
      record.status = 'prepared'; record.gaps = ['insufficient_episode_budget']; return record;
    }
    record.qualification = qualified.binding;
    if (!localRuntime) session = new ApiSession({ budget: config.budget, directory: path.join(out, 'api'), environment: runtime.environment,
      transport: runtime.transport, timeoutMs: config.timeout_ms, audioBackend: backend });
    for (const [index, source_range] of windows.entries()) {
      const windowFrames = frames.filter(frame => frame.timeline_seconds >= source_range[0] && frame.timeline_seconds < source_range[1]);
      const windowKey = signature({ source: sourceBinding, audio: audioBinding, source_range, frames: windowFrames,
        mode, backend, observer: localRuntime ? runtime.observer_backend_id : null,
        revision: localRuntime ? runtime.observer_model_revision ?? runtime.observer.version ?? null : null,
        model_bindings: config.model_bindings ?? null, qualification: qualified.binding ?? null, version: 1 });
      const cached = state.observations[windowKey];
      if (cached) {
        if (!await currentBindings(cached)) throw new Error('cached_window_evidence_changed');
        observations.push({ ...cached.row, observation_id: task.windows[index].observation_id });
        localEvidence.push(...cached.evidence);
        record.counts.reused_observation_windows++;
        record.counts.observation_windows = observations.length;
        record.coverage = observationCoverage(duration, planned, observations);
        continue;
      }
      const windowOut = path.join(out, 'observations', String(index + 1));
      const video = await prepareReviewWindow({ video: source, video_sha256: sourceBinding.sha256,
        audio: original, audio_sha256: audioBinding.sha256, first_pts_seconds: manifest.video.first_pts_seconds,
        source_range }, path.join(windowOut, 'synchronized.mp4'));
      const job = { path: original, source_sha256: audioBinding.sha256,
        source_video_sha256: sourceBinding.sha256, source_range, asset_id: 'reference-original',
        segment_id: `${config.episode_id}/${index + 1}` };
      let row; const evidence = [];
      record.observation_calls_this_run++;
      if (localRuntime) {
        const identity = await prepareApiAudio(job, path.join(windowOut, 'input.wav'));
        const input = { ...identity, source_video_sha256: sourceBinding.sha256, synchronized_video: video, frames: windowFrames };
        const request = await saveJson(path.join(windowOut, 'research-input.json'), input);
        record.runtime_calls++;
        const result = await runtimeResponse(await runtime.observer(input, windowOut), sourceBinding.sha256, source_range);
        if (await hashFile(identity.input_audio.path) !== identity.input_audio.sha256
          || await hashFile(video.path) !== video.sha256) throw new Error('research_runtime_input_changed');
        row = { ...identity, source_video_sha256: sourceBinding.sha256, model: result.model,
          ...(result.backend_id ? { backend_id: result.backend_id } : {}),
          ...(result.model_revision ? { model_revision: result.model_revision } : {}),
          observation: result.value, input_request: request, api_evidence: result.raw_response,
          synchronized_video: video, actual_audio_processed: true,
          actual_video_processed: result.actual_video_processed === true && result.synchronized_video_sha256 === video.sha256,
          qualified: false, artistic_approval: false,
          evidence_status: 'unqualified_research_prediction', completion_status: 'complete' };
        row.file = await saveJson(path.join(windowOut, 'observation.json'), row);
        evidence.push(request, result.raw_response, ...(result.evidence_files ?? []));
      } else row = await session.observeAudio(job, windowOut, { video, frames: windowFrames, purpose: 'original' });
      if (mode === 'verified' && !audioBackendMatches(row, backend)) throw new Error('observation_backend_not_qualified');
      evidence.push(...apiBindings(session, out));
      await verifyEvidenceBindings(evidence);
      state.observations[windowKey] = { row, evidence };
      await checkpoint.save();
      localEvidence.push(...evidence);
      observations.push({ ...row, observation_id: task.windows[index].observation_id });
      record.counts.observation_windows = observations.length;
      record.coverage = observationCoverage(duration, planned, observations);
    }
    record.actual_audio_processed = record.coverage.complete_processed;
    record.actual_video_processed = record.coverage.complete_processed && (!localRuntime
      || observations.every(row => row.actual_video_processed === true));
    const observationsFile = await saveJson(path.join(out, 'actual-observations.json'), observations);
    const directorInput = { prompt, schema: distillationSchemaForObservations(observations), stage: 'reference_case_distillation', frames,
      data: { source_video_sha256: sourceBinding.sha256, duration_seconds: duration,
        audio_observations: observations.map(row => ({ observation_id: row.observation_id, source_range: row.source_range,
          observation: row.observation, synchronized_video: row.synchronized_video })) } };
    const directorKey = signature({ input: directorInput, observations: observations.map(row => row.file),
      mode, backend: localRuntime ? runtime.director_backend_id : 'gpt-6.1-sol',
      revision: runtime.director_model_revision ?? runtime.director?.version ?? null,
      model_bindings: config.model_bindings ?? null, qualification: qualified.binding ?? null });
    const priorDirector = state.directors[directorKey], directorEvidence = [];
    const validateDirectorValue = value => mode === 'research'
      ? deriveResearchObservationReferences(value, sourceBinding.sha256, duration, observations)
      : validateCases(value, sourceBinding.sha256, duration, observations);
    let response;
    if (priorDirector) {
      if (!await currentBindings(priorDirector)) throw new Error('cached_director_evidence_changed');
      response = localRuntime ? await runtimeResponse(priorDirector.response, sourceBinding.sha256) : priorDirector.response;
      directorEvidence.push(...priorDirector.evidence);
      record.director_reused = true;
    } else if (localRuntime) {
      directorEvidence.push(await saveJson(path.join(out, 'research-director-input.json'), directorInput));
      record.runtime_calls++;
      record.director_calls_this_run++;
      response = await runtimeResponse(await runtime.director(directorInput, out,
        { validateValue: validateDirectorValue }), sourceBinding.sha256);
      await recordCliUsage(record, response.cli_receipts);
      validateSchema(response.value, directorInput.schema); directorEvidence.push(response.raw_response, ...(response.evidence_files ?? []));
    } else {
      record.director_calls_this_run++;
      response = await session.director(directorInput);
    }
    localEvidence.push(...directorEvidence);
    record.director_response = await saveJson(path.join(out, 'director-result.json'), response.value);
    if (await hashFile(source) !== sourceBinding.sha256 || await hashFile(original) !== audioBinding.sha256
      || qualified.binding && await hashFile(qualified.binding.path) !== qualified.binding.sha256) throw new Error('distillation_input_changed');
    if (qualified.binding && !(await validateAudioQualification(qualified.binding, backend, ['audio_observation'])).ready)
      throw new Error('distillation_qualification_evidence_changed');
    const classified = validateDirectorValue(response.value);
    const apiFiles = apiBindings(session, out);
    for (const binding of apiFiles) {
      if (await hashFile(binding.path) !== binding.sha256) throw new Error('api_evidence_changed_after_submission');
    }
    await verifyEvidenceBindings(localEvidence);
    if (classified.changes.length) {
      record.director_derived_response = await saveJson(path.join(out, 'director-derived-result.json'), classified.value);
      record.director_reference_derivation = await saveJson(path.join(out, 'director-reference-derivation.json'), {
        schema_version: 1, mode, derivation_revision: 'research-event-parent-reference-union-v1',
        reason: 'event_declared_observations_added_to_redundant_parent_references', source_video_sha256: sourceBinding.sha256,
        original_parent_coverage_required: true, raw_response: response.raw_response, declared_result: record.director_response,
        derived_result: record.director_derived_response, actual_observations: observationsFile, changes: classified.changes,
        qualification_granted: false, artistic_approval: false, production_approval: false });
      directorEvidence.push(record.director_derived_response, record.director_reference_derivation);
      localEvidence.push(record.director_derived_response, record.director_reference_derivation);
    }
    if (!priorDirector) {
      state.directors[directorKey] = { response, evidence: [...directorEvidence, ...apiFiles] };
      await checkpoint.save();
    }
    document.cases = classified.value.cases.map(item => ({ ...item,
      case_id: `${config.episode_id}/${shaBytes(JSON.stringify([sourceBinding.sha256, item.local_id, item.source_range])).slice(0, 16)}`,
      episode_id: config.episode_id, status: mode === 'verified' ? 'observed' : 'research', conditions: known(item.conditions),
      story_sequence: item.story_sequence.map(step => ({ ...step, before: known(step.before), after: known(step.after) })),
      music_pack_ids: [], theme_bundle_ids: [], sound_pack_ids: [],
      development_preset: { steps: item.development_preset.steps.map(step => ({ ...step,
        music_pack_ids: [], window_refs: [], sound_pack_ids: [] })) },
      unresolved_gaps: ['music_recording_source_unresolved', 'clean_sound_assets_unresolved', ...item.uncertainties],
      evidence: { source_video_sha256: sourceBinding.sha256, source_range: item.source_range,
        actual_audio_processed: true, actual_video_processed: record.actual_video_processed,
        observations: { description: item.description, music: item.music_observations, sounds: item.sound_effects },
        files: [record.task, record.input_manifest, audioBinding, ...frames.map(frame => ({ path: frame.path, sha256: frame.sha256 })),
          observationsFile, record.director_response, response.raw_response, ...(qualified.binding ? [qualified.binding] : []), ...apiFiles, ...localEvidence,
          ...observations.map(row => row.api_evidence),
          ...observations.filter(row => item.observation_ids.includes(row.observation_id)).flatMap(row => [row.file, row.input_audio, row.synchronized_video])],
        observation_ids: item.observation_ids, qualification_record: qualified.binding ?? null,
        audio_backend: backend,
        evidence_status: mode === 'verified' ? 'qualified_fact_observation' : 'unqualified_research_prediction', artistic_approval: false } }));
    const events = new Map();
    for (const item of document.cases) for (const event of item.source_events) {
      const identity = JSON.stringify([event.kind, event.source_range, event.description]);
      const saved = events.get(identity);
      if (saved) saved.case_event_refs.push({ case_id: item.case_id, event_id: event.event_id });
      else events.set(identity, { ...event, case_event_refs: [{ case_id: item.case_id, event_id: event.event_id }] });
    }
    record.source_events = [...events.values()];
    record.coverage.classified_case_ranges = document.cases.map(item => item.source_range);
    record.coverage.unclassified_ranges = observationCoverage(duration, [], document.cases).missing_ranges;
    record.coverage.sound_semantics_verified = mode === 'verified' && record.coverage.unclassified_ranges.length === 0 && document.cases.length > 0;
    document.episodes[0].media_status = mode === 'verified' && record.coverage.sound_semantics_verified ? 'observed' : 'acquired';
    record.counts.cases = document.cases.length;
    record.gaps = [...response.value.uncertainties, ...(document.cases.length ? ['reference_sources_not_material_packs'] : ['no_observed_case'])];
    if (record.coverage.unclassified_ranges.length) record.gaps.push('full_episode_case_classification_incomplete');
    record.status = document.cases.length && !record.coverage.unclassified_ranges.length
      ? mode === 'verified' ? 'observed' : 'research_processed' : 'distillation_needs_review';
  } catch (error) {
    if (error.cli_receipts) await recordCliUsage(record, error.cli_receipts);
    const safe = error.code === 'DIRECTOR_RESPONSE_PENDING' || error.code === 'host_response_pending' || error.name === 'HostResponsePendingError'
      ? 'director_response_pending'
      : error.message && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'distillation_media_or_response_failed';
    record.status = safe.includes('outcome_unknown') ? 'api_outcome_unknown' : session || localRuntime ? 'distillation_needs_review' : 'media_failed';
    if (safe === 'director_response_pending') record.status = 'director_response_pending';
    if (error.code === 'account_quota_wait') { record.status = 'account_quota_wait'; record.error = 'account_quota_wait'; }
    if (error.request_file) record.pending_request = { request_file: error.request_file, response_file: error.response_file };
    if (record.status === 'api_outcome_unknown' && record.parent_video) {
      state.unknown_outcomes[record.parent_video.sha256] = true;
      await checkpoint.save();
    }
    record.error ??= safe; record.gaps.push(record.error);
  } finally {
    record.model_calls = session?.ledger.length ?? 0; record.cloud_uploads = record.model_calls;
    if (document) {
      record.import_document = document;
      record.artifact = await saveJson(path.join(out, 'case-import.json'), document);
      record.case_import_file = record.artifact.path; record.artifact_path = record.artifact.path;
    }
    record.record_file = path.join(out, 'distillation-record.json');
    await saveJson(record.record_file, record);
  }
  return record;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await distillEpisode(await readJson(process.argv[2]));
    process.stdout.write(JSON.stringify({ status: result.status, work_id: result.work_id,
      episode_id: result.episode_id, case_import_file: result.case_import_file, model_calls: result.model_calls }) + '\n');
    if (result.error) process.exitCode = 1;
  } catch { process.stderr.write('distill_episode: invalid configuration or occupied output directory\n'); process.exitCode = 1; }
}
