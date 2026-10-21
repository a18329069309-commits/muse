import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { objectSchema, readJson, saveJson, validateSchema, audioBackendMatches } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const sameRange = (a, b) => range(a) && range(b) && a.every((v, i) => v === b[i]);
const requireFact = (condition, reason) => { if (!condition) throw new Error(reason); };

const requestSchema = objectSchema({
  caption: { type: 'string', minLength: 1, maxLength: 512 },
  duration_seconds: { type: 'number', minimum: 10, maximum: 120 },
  seed: { type: 'integer', minimum: 0, maximum: 4294967295 },
  vocal_mode: { type: 'string', enum: ['instrumental', 'lyrics'] },
  lyrics: { type: 'string', maxLength: 4096 },
  vocal_language: { type: 'string', enum: ['unknown', 'zh'] },
  lyrics_original: { type: 'boolean' },
  artist_reference: { type: 'string', enum: ['none'] },
});

async function boundJson(binding, label) {
  requireFact(binding && text(binding.path) && hash(binding.sha256), `${label}_binding_required`);
  requireFact(await hashFile(binding.path) === binding.sha256, `${label}_binding_changed`);
  return readJson(binding.path);
}

async function verifyGap(config, gap) {
  requireFact(config.craft_mode === 'fine', 'local_generation_requires_fine_mode');
  requireFact(hash(config.source_video_sha256) && gap?.source_video_sha256 === config.source_video_sha256,
    'gap_must_bind_current_source_video');
  requireFact(text(gap.cue_id) && range(gap.target_range) && text(gap.function) && text(gap.sound_goal),
    'specific_cue_target_function_and_sound_required');
  const diagnosis = gap.diagnosis;
  requireFact(diagnosis?.type === 'verified_local_catalog_gap', 'verified_local_catalog_gap_required');
  requireFact(diagnosis.source_video_sha256 === gap.source_video_sha256 && diagnosis.cue_id === gap.cue_id
    && text(diagnosis.reason), 'diagnosis_source_and_cue_binding_required');
  requireFact(Array.isArray(gap.retrieval_rounds) && gap.retrieval_rounds.length === 2
    && new Set(gap.retrieval_rounds.map(r => r.round)).size === 2
    && gap.retrieval_rounds.every(r => r.round === 1 || r.round === 2), 'two_bound_retrieval_rounds_required');
  const rounds = [];
  for (const round of gap.retrieval_rounds) {
    requireFact(round.source_video_sha256 === gap.source_video_sha256 && round.cue_id === gap.cue_id
      && sameRange(round.target_range, gap.target_range) && round.function === gap.function,
    'retrieval_round_must_bind_same_picture_cue');
    const ranked = await boundJson(round.retrieval_binding, 'retrieval');
    const comparison = await boundJson(round.comparison_binding, 'comparison');
    const pool = ranked.cues?.find(c => c.cue_id === gap.cue_id)?.candidate_pool;
    const decisions = comparison.decisions?.filter(c => c.cue_id === gap.cue_id);
    requireFact(Array.isArray(pool) && pool.length && decisions?.length === 1
      && decisions[0].selected_segment_id === null && !(comparison.uncertainties?.length),
    'actual_current_cue_retrieval_and_rejected_comparison_required');
    requireFact(Array.isArray(round.rejections) && round.rejections.length > 0, 'qualified_rejection_reasons_required');
    requireFact(new Set(round.rejections.map(r => r.segment_id)).size === round.rejections.length
      && decisions[0].alternatives?.length === round.rejections.length,
    'each_compared_rejection_requires_qualified_observation');
    const actual = [];
    for (const rejection of round.rejections) {
      requireFact(hash(rejection.source_sha256) && range(rejection.source_range) && text(rejection.reason)
        && pool.some(c => c.segment_id === rejection.segment_id && c.source_sha256 === rejection.source_sha256)
        && decisions[0].alternatives?.some(c => c.segment_id === rejection.segment_id && c.reason === rejection.reason),
      'rejection_must_match_retrieved_and_compared_candidate');
      const qualification = await boundJson(rejection.qualification_record, 'listener_qualification');
      requireFact(qualification.status === 'qualified' && text(qualification.backend_id)
        && ['audio_observation', 'music_candidate_judgment'].every(s => qualification.scopes?.includes(s)),
      'qualified_audio_listener_required');
      const observation = await boundJson(rejection.observation_record, 'rejected_audio_observation');
      requireFact(observation.actual_audio_processed === true && observation.execution?.actual_audio_processed === true
        && observation.completion_status === 'complete' && audioBackendMatches(observation, qualification)
        && observation.source_sha256 === rejection.source_sha256
        && sameRange(observation.source_range, rejection.source_range) && text(observation.raw_observation),
      'rejection_requires_actual_bound_audio_observation');
      requireFact(observation.input_audio && await hashFile(observation.input_audio.path) === observation.input_audio.sha256,
        'observed_input_audio_changed');
      actual.push({ segment_id: rejection.segment_id, reason: rejection.reason,
        backend_id: qualification.backend_id, model_revision: qualification.model_revision,
        protocol: qualification.protocol, observation: observation.observation });
    }
    rounds.push({ round: round.round, actual_rejections: actual });
  }
  requireFact(gap.retrieval_rounds[0].retrieval_binding.sha256 !== gap.retrieval_rounds[1].retrieval_binding.sha256
    && gap.retrieval_rounds[0].comparison_binding.sha256 !== gap.retrieval_rounds[1].comparison_binding.sha256,
  'two_distinct_retrieval_and_comparison_records_required');
  return rounds;
}

async function localReadiness(local) {
  const missing = [];
  for (const name of ['python', 'repo', 'checkpoints']) {
    try {
      if (!text(local?.[name])) throw new Error('missing');
      const info = await stat(local[name]);
      if (name === 'python' ? !info.isFile() : !info.isDirectory()) throw new Error('missing');
    } catch { missing.push(name); }
  }
  return missing;
}

function validateRequest(value, gap) {
  validateSchema(value, requestSchema, 'local_caption');
  requireFact(text(value.caption) && value.caption.trim().length <= 512
    && value.duration_seconds >= Math.max(10, gap.target_range[1] - gap.target_range[0]) && value.duration_seconds <= 120
    && Number.isSafeInteger(value.seed) && value.seed >= 0 && value.seed <= 4294967295,
  'bounded_local_generation_caption_duration_seed_required');
  requireFact(!/\b(?:in the style of|sounds? like|imitat(?:e|ing|ion)|cover of)\b|模仿|仿唱|翻唱/i.test(value.caption),
    'specific_artist_imitation_not_allowed');
  requireFact(!/\b(?:no|not|without|avoid|exclude)\b|不要|不使用|避免|禁止/i.test(value.caption),
    'positive_sound_caption_required');
  const words = value.lyrics.replace(/\[[^\]]*\]/g, '').trim();
  requireFact(value.lyrics.length <= 4096 && (value.vocal_mode === 'lyrics'
    ? value.vocal_language === 'zh' && value.lyrics_original === true && /[\u3400-\u9fff]/.test(words)
    : !words && value.vocal_language === 'unknown' && value.lyrics_original === false),
  'explicit_instrumental_or_original_chinese_words_required');
  requireFact(!(gap.music_role === 'words_candidate' || gap.vocal_language === 'zh') || value.vocal_mode === 'lyrics',
    'chinese_words_task_requires_actual_lyrics_request');
  return { craft_mode: 'fine', vocal_mode: value.vocal_mode, caption: value.caption.trim(),
    duration_seconds: value.duration_seconds, seed: value.seed,
    ...(value.vocal_mode === 'lyrics' ? { lyrics: value.lyrics, vocal_language: 'zh' } : {}),
    cue_id: gap.cue_id, source_video_sha256: gap.source_video_sha256 };
}

export async function createVerifiedGap({ config, session, gap, output_dir }) {
  const rounds = await verifyGap(config, gap), missing = await localReadiness(config.local_generation);
  if (missing.length) return { status: 'needs_local_generator', missing, generation_calls: 0, model_calls: 0,
    cloud_uploads: 0, production_approval: false };
  requireFact(session && typeof session.director === 'function' && typeof session.observeAudio === 'function',
    'director_and_actual_audio_observer_required');
  const out = path.resolve(output_dir); await mkdir(path.dirname(out), { recursive: true }); await mkdir(out);
  const caption = await session.director({ stage: 'verified_local_gap_caption', schema: requestSchema,
    prompt: '只为这一本片cue补足已核实的本地目录声音缺口。两轮候选不适合不代表全世界没有合适音乐。'
      + '输出正向声音描述caption，1–512字：具体乐器、律动、织体、可听发展及落点；不模仿命名歌手或歌曲。'
      + 'duration_seconds为10–120且容纳该cue；seed为0–4294967295整数。仅需歌句时创作中文原创实际词句，'
      + 'lyrics不能只有段落标签，vocal_language=zh、lyrics_original=true。器乐则lyrics为空、unknown、false。'
      + 'artist_reference必须none。此处只生成候选，后续必须实际听审和正式选曲。',
    data: { source_video_sha256: gap.source_video_sha256, cue_id: gap.cue_id, target_range: gap.target_range,
      function: gap.function, sound_goal: gap.sound_goal, vocal_language: gap.vocal_language ?? 'unknown',
      music_role: gap.music_role ?? 'primary', diagnosis: gap.diagnosis, local_catalog_rejections: rounds } });
  const request = validateRequest(caption.value, gap), requestFile = path.join(out, 'generation-request.json');
  await saveJson(requestFile, request);
  const generated = path.join(out, 'generated'), local = config.local_generation;
  await (local.processRunner ?? execute)(local.python, [path.join(here, 'generate_local_music.py'), requestFile,
    '--repo', local.repo, '--checkpoints', local.checkpoints, '--checkpoint', 'acestep-v15-turbo', '--out', generated],
  { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const recordFile = path.join(generated, 'generation-record.json'), record = await readJson(recordFile);
  requireFact(['candidate_generated_needs_audition', 'candidate_generated_degraded_needs_audition'].includes(record.status)
    && record.request?.source_video_sha256 === gap.source_video_sha256 && record.request?.cue_id === gap.cue_id
    && ['seed', 'caption', 'duration_seconds', 'vocal_mode', 'lyrics', 'vocal_language'].every(k => record.request?.[k] === request[k])
    && record.files?.length === 1, 'one_actual_generated_candidate_record_required');
  const file = record.files[0], relative = path.relative(generated, path.resolve(file.path));
  requireFact(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && file.technical_valid === true
    && Number.isFinite(file.duration_seconds) && Math.abs(file.duration_seconds - request.duration_seconds) <= .5,
  'generated_audio_must_be_technical_valid_local_output');
  const actualSha = await hashFile(file.path);
  requireFact(actualSha === file.sha256, 'generated_file_sha_mismatch');
  const candidate = { asset_id: `generated-${actualSha}`, segment_id: `generated/${gap.cue_id}/${actualSha.slice(0, 12)}`,
    path: path.resolve(file.path), local_path: path.resolve(file.path), source_sha256: actualSha,
    sha256: actualSha, caption: request.caption, lyrics: request.lyrics ?? '', vocal_mode: request.vocal_mode,
    source_range: [0, file.duration_seconds], duration_seconds: file.duration_seconds,
    source_video_sha256: gap.source_video_sha256, cue_id: gap.cue_id, target_range: gap.target_range,
    function: gap.function, asset_kind: 'music', source_kind: 'generated_candidate', vocal_presence: 'unknown',
    vocal_language: 'unknown', listening_status: 'pending', artistic_approval: false };
  const observation = await session.observeAudio(candidate, path.join(out, 'actual-audio-observation'),
    { purpose: 'candidate', context: { function: gap.function, target_range: gap.target_range } });
  requireFact(observation.actual_audio_processed === true && observation.execution?.actual_audio_processed === true
    && rounds.some(r => r.actual_rejections.some(a => audioBackendMatches(observation, a)))
    && observation.source_sha256 === actualSha && sameRange(observation.source_range, candidate.source_range)
    && observation.completion_status === 'complete'
    && observation.input_audio && await hashFile(observation.input_audio.path) === observation.input_audio.sha256,
  'generated_candidate_requires_actual_audio_observation');
  await boundJson(observation.file, 'generated_audio_observation');
  candidate.observation_record = observation.file;
  candidate.observation = observation.observation;
  const result = { status: 'candidate_generated_needs_formal_selection', candidate, observation,
    generation_record: { path: recordFile, sha256: await hashFile(recordFile) },
    generation_calls: 1, director_calls: 1, audio_observation_calls: 1, production_approval: false,
    scope: 'this_source_video_and_cue_only', world_catalog_gap_claimed: false };
  await saveJson(path.join(out, 'gap-result.json'), result);
  return result;
}
