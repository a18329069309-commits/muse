import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashFile } from './render_binding.mjs';

const execute = promisify(execFile);
export const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
export const shaBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const saveJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  return { path: path.resolve(file), sha256: await hashFile(file) };
};
export const DEFAULT_AUDIO_BACKEND = Object.freeze({ protocol: 'gemini_interactions',
  backend_id: 'gemini-3.8-flash', model_revision: 'gemini-3.8-flash' });

// A model name is an identity, not an implemented media protocol or a qualification.
export function resolveAudioBackend(value = DEFAULT_AUDIO_BACKEND) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['gemini_interactions', 'local_audio_model'].includes(value.protocol)) throw new Error('unsupported_audio_backend_protocol');
  if (typeof value.backend_id !== 'string' || !/^[a-zA-Z0-9._:/-]+$/.test(value.backend_id)
    || typeof value.model_revision !== 'string' || !(value.protocol === 'gemini_interactions'
      ? /^gemini-[a-zA-Z0-9._-]+$/.test(value.model_revision)
      : /^[a-zA-Z0-9._:/@+-]+$/.test(value.model_revision) && !['unknown', 'latest'].includes(value.model_revision)))
    throw new Error('explicit_audio_backend_identity_required');
  return { protocol: value.protocol, backend_id: value.backend_id, model_revision: value.model_revision };
}

export function audioBackendMatches(record, expected) {
  const identity = value => {
    if (!value) return null;
    if (value.backend_id === DEFAULT_AUDIO_BACKEND.backend_id && !value.model_revision && !value.protocol
      || value.model === DEFAULT_AUDIO_BACKEND.model_revision && !value.backend_id && !value.model_revision && !value.protocol)
      return DEFAULT_AUDIO_BACKEND;
    try { return resolveAudioBackend(value); } catch { return null; }
  };
  const a = identity(record), b = identity(expected);
  return Boolean(a && b && a.backend_id === b.backend_id && a.model_revision === b.model_revision
    && a.protocol === b.protocol && (!record.model || record.model === a.model_revision));
}

export async function verifyEvidenceBindings(value) {
  if (!value || typeof value !== 'object') return;
  const digest = value.sha256 ?? value.actual_sha256;
  if (value.path && digest) {
    if (!/^[a-f0-9]{64}$/.test(digest) || await hashFile(value.path) !== digest)
      throw new Error('audio_evidence_binding_changed');
    if (value.expected_sha256 && value.expected_sha256 !== digest) throw new Error('audio_evidence_binding_changed');
  }
  for (const item of Object.values(value)) if (item && typeof item === 'object') await verifyEvidenceBindings(item);
}

// A local forward receipt is separate from a remote submission receipt. It does not grant listening qualification.
export async function verifyLocalAudioExecution(record, backend) {
  if (resolveAudioBackend(backend).protocol !== 'local_audio_model' || !audioBackendMatches(record, backend)
    || record.actual_audio_processed !== true || record.completion_status !== 'complete'
    || !record.local_evidence?.path || !record.local_evidence.sha256) throw new Error('local_audio_execution_evidence_required');
  await verifyEvidenceBindings(record.local_evidence);
  const receipt = await readJson(record.local_evidence.path), range = record.source_range;
  if (!audioBackendMatches(receipt, backend) || !/^[a-f0-9]{64}$/.test(record.source_sha256 ?? '')
    || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0]
    || receipt.source_sha256 !== record.source_sha256 || JSON.stringify(receipt.source_range) !== JSON.stringify(range)
    || !receipt.source_binding?.path || receipt.source_binding.sha256 !== record.source_sha256
    || !receipt.input_audio?.path || !receipt.input_audio.sha256 || !receipt.raw_result?.path || !receipt.raw_result.sha256
    || receipt.execution?.actual_audio_processed !== true || !(receipt.execution.forward_count > 0)
    || !Number.isSafeInteger(receipt.execution.forward_count)
    || receipt.execution.input_audio_sha256 !== receipt.input_audio.sha256
    || receipt.execution.model_revision !== backend.model_revision
    || record.input_audio && (record.input_audio.sha256 !== receipt.input_audio.sha256
      || path.resolve(record.input_audio.path) !== path.resolve(receipt.input_audio.path)))
    throw new Error('local_audio_execution_binding_invalid');
  await verifyEvidenceBindings(receipt);
  const raw = await readJson(receipt.raw_result.path);
  if (JSON.stringify(raw.observation ?? raw) !== JSON.stringify(record.observation))
    throw new Error('local_audio_result_observation_mismatch');
  return receipt;
}

export async function validateAudioQualification(supplied, backend, scopes) {
  const file = typeof supplied === 'string' ? supplied : supplied?.path;
  const pending = { ready: false, missing: ['qualified_audio_listener'] };
  if (!file) return pending;
  try {
    const binding = { path: path.resolve(file), sha256: await hashFile(file) };
    if (supplied?.sha256 && supplied.sha256 !== binding.sha256) return pending;
    const value = await readJson(file);
    if (value.status !== 'qualified' || !audioBackendMatches(value, backend)
      || !scopes.every(scope => value.scopes?.includes(scope))) return pending;
    // Version 1 is limited to the one historical Gemini identity. New identities need bound calibration artifacts.
    if ((value.schema_version ?? 1) < 2 && (value.backend_id !== DEFAULT_AUDIO_BACKEND.backend_id
      || value.model_revision && value.model_revision !== DEFAULT_AUDIO_BACKEND.model_revision)) return pending;
    if (value.schema_version >= 2 && (!value.evidence?.path || !value.evidence.sha256
      || !value.fixture_manifest?.path || !value.fixture_manifest.sha256 || !value.results?.length)) return pending;
    if (value.schema_version >= 2) {
      const facts = value.fixture_results?.filter(row => row.truth_group === 'real_audio') ?? [];
      const scenes = value.scene_pair_results ?? [];
      const passed = rows => rows.every(row => row.status === 'scored' && Array.isArray(row.reasons) && !row.reasons.length);
      if (scopes.includes('audio_observation') && (value.truth_coverage?.real_audio_sufficient !== true
        || facts.length < 16 || !passed(facts))) return pending;
      if (scopes.includes('music_candidate_judgment') && (!value.scopes.includes('audio_observation')
        || value.truth_coverage?.scene_truth_sufficient !== true || new Set(scenes.map(row => row.scene_kind)).size < 3
        || !passed(scenes))) return pending;
      if (value.results.some(row => !audioBackendMatches(row, backend) || row.actual_audio_processed !== true
        || row.audit_binding_verified !== true || row.completion_status !== 'complete'
        || !(backend.protocol === 'local_audio_model' ? row.local_evidence?.sha256 : row.api_evidence?.sha256))) return pending;
      if (backend.protocol === 'local_audio_model') for (const result of value.results) await verifyLocalAudioExecution(result, backend);
    }
    await verifyEvidenceBindings(value);
    if (await hashFile(file) !== binding.sha256) return pending;
    return { ready: true, binding, backend: resolveAudioBackend(backend),
      legacy_identity: !value.model_revision, missing: [] };
  } catch { return pending; }
}
export const objectSchema = properties => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string' }, num = { type: 'number' }, strings = { type: 'array', items: str };
export const audioSchema = objectSchema({
  vocal_type: { type: 'string', enum: ['none', 'speech', 'sung', 'vocalise', 'mixed', 'unknown'] },
  language: str, description: str, instruments: strings,
  original_audio_kind: { type: 'string', enum: ['dialogue_only', 'mixed', 'none', 'unknown'] },
  words: { type: 'array', items: objectSchema({ text: str, start_seconds: num, end_seconds: num,
    kind: { type: 'string', enum: ['speech', 'sung'] } }) },
  changes: { type: 'array', items: objectSchema({ time_seconds: num, description: str }) },
  issues: { type: 'array', items: objectSchema({ start_seconds: num, end_seconds: num, kind: str, reason: str }) },
  uncertainties: strings,
});
export const audioWordsSchema = objectSchema({ ...audioSchema.properties,
  sung_phrase: objectSchema({ complete_phrase: { type: 'boolean' }, actual_words: str,
    start_seconds: num, end_seconds: num, reason: str }),
});

// The provider's schema is also checked locally; receiving JSON is not a music qualification.
export function validateSchema(value, schema, label = 'response') {
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label}_enum_invalid`);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(kind) && !(types.includes('integer') && Number.isSafeInteger(value))) throw new Error(`${label}_type_invalid`);
  if (kind === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) throw new Error(`${label}_pattern_invalid`);
  if (kind === 'number' && !Number.isFinite(value)) throw new Error(`${label}_number_invalid`);
  if (kind === 'number' && schema.minimum !== undefined && value < schema.minimum) throw new Error(`${label}_minimum_invalid`);
  if (kind === 'number' && schema.maximum !== undefined && value > schema.maximum) throw new Error(`${label}_maximum_invalid`);
  if (kind === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) throw new Error(`${label}_${key}_required`);
    for (const [key, item] of Object.entries(value)) {
      if (!schema.properties?.[key]) {
        if (schema.additionalProperties === false) throw new Error(`${label}_extra_field`);
      } else validateSchema(item, schema.properties[key], `${label}_${key}`);
    }
  }
  if (kind === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${label}_length_invalid`);
    for (const item of value) validateSchema(item, schema.items, label);
  }
  return value;
}

export function providerReadiness(budget, environment = process.env, providers = ['openai', 'gemini']) {
  if (providers.some(provider => !['openai', 'gemini'].includes(provider))) throw new Error('unsupported_api_provider');
  const missing = [];
  if (providers.includes('openai') && !environment.OPENAI_API_KEY?.trim()) missing.push('OPENAI_API_KEY');
  if (providers.includes('gemini') && !(environment.GEMINI_API_KEY || environment.GOOGLE_API_KEY)?.trim()) missing.push('GEMINI_API_KEY');
  if (budget?.enabled !== true || !Number.isSafeInteger(budget.max_calls) || budget.max_calls < 1
    || !(budget.max_estimated_cost_usd > 0) || !(budget.per_call_cost_ceiling_usd > 0)
    || !Number.isFinite(budget.max_estimated_cost_usd) || !Number.isFinite(budget.per_call_cost_ceiling_usd)) missing.push('explicit_api_budget');
  return { ready: missing.length === 0, missing, model_calls: 0, cloud_uploads: 0 };
}

const redact = (text, environment) => {
  for (const name of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
    const secret = environment[name];
    if (secret) text = text.split(secret).join('<REDACTED>');
  }
  return text;
};

const reviewContract = 'exact_audio_picture_submission_v1';
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function finiteJson(value, seen = new Set()) {
  if (typeof value === 'number' && !Number.isFinite(value) || ['function','symbol','bigint'].includes(typeof value))
    throw Error('audio_review_json_value_invalid');
  if (value && typeof value === 'object') {
    if (seen.has(value)) throw Error('audio_review_json_value_invalid');
    seen.add(value); for (const item of Object.values(value)) finiteJson(item, seen); seen.delete(value);
  }
}
function strictBinding(value) {
  if (!value || !path.isAbsolute(value.path ?? '') || !/^[a-f0-9]{64}$/.test(value.sha256 ?? ''))
    throw Error('audio_review_absolute_hashed_binding_required');
  return value;
}
const positiveTimeout = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw Error('audio_review_timeout_invalid');
  return value;
};
function reviewOptions(options = {}) {
  const {purpose, frames = [], video, context = null, processing = {type: 'static', fps: 1}, resolution = 'low'} = options;
  if (purpose !== 'mix' || !Array.isArray(frames) || frames.length || !video?.path || !video.sha256
    || !sameJson(processing, {type: 'static', fps: 1}) || resolution !== 'low'
    || Object.keys(options).some(key => !['purpose','frames','video','context','processing','resolution','prepared_request','timeoutMs'].includes(key)))
    throw Error('audio_review_static_mix_contract_required');
  strictBinding(video); finiteJson({context, video});
  return JSON.parse(JSON.stringify({purpose, frames, video: {...video, path: path.resolve(video.path)}, context, processing, resolution}));
}
function reviewJob(job) {
  if (!job || !path.isAbsolute(job.path ?? '') || !/^[a-f0-9]{64}$/.test(job.source_sha256 ?? ''))
    throw Error('audio_review_source_identity_required');
  finiteJson(job);
  if (!Array.isArray(job.source_range) || job.source_range.length !== 2 || !job.source_range.every(Number.isFinite)
    || job.source_range[0] < 0 || job.source_range[1] <= job.source_range[0] || job.source_range[1] - job.source_range[0] > 180)
    throw Error('bounded_api_audio_window_required');
  return JSON.parse(JSON.stringify({...job, path: path.resolve(job.path)}));
}
function reviewBackend(backend) {
  if (!audioBackendMatches(backend, DEFAULT_AUDIO_BACKEND)) throw Error('audio_review_model_not_registered');
  return resolveAudioBackend(backend);
}
function mixPrompt(context) {
  return 'Describe only this actual audio and synchronized video. Report actual instruments, pulse and development; '
    + 'distinguish sung words, speech and wordless voice. Transcribe only short words clearly heard; uncertainty is allowed. '
    + 'All times are relative to the submitted clip. Do not invent words in silence or instrumental music. '
    + 'Check narrative fit, audible accents, dialogue masking and music transitions. '
    + `Task context for picture review only: ${JSON.stringify(context)}`;
}
async function reviewMedia(video, duration) {
  const info = await stat(video.path);
  if (!info.isFile() || info.size < 1 || info.size > 14 * 1024 * 1024) throw Error('audio_review_inline_video_size_invalid');
  const probe = JSON.parse((await execute('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',video.path],
    {windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024})).stdout);
  const picture = probe.streams?.find(row => row.codec_type === 'video'), sound = probe.streams?.find(row => row.codec_type === 'audio');
  const mediaDuration = Number(probe.format?.duration), rate = String(picture?.avg_frame_rate ?? '').split('/').map(Number);
  const frameSeconds = rate[1] / rate[0], pictureDuration = Number(picture?.duration), audioDuration = Number(sound?.duration);
  const sampleRate = Number(sound?.sample_rate), audioTolerance = 1024 / sampleRate + 1 / 16000;
  if (!picture || !sound || !Number.isFinite(mediaDuration) || mediaDuration <= 0
    || !Number.isFinite(frameSeconds) || frameSeconds <= 0 || frameSeconds > 1 || !Number.isFinite(sampleRate) || sampleRate <= 0
    || ![picture.start_time, sound.start_time].every(value => value !== undefined && Number.isFinite(Number(value)) && Math.abs(Number(value)) <= .002)
    || ![pictureDuration,audioDuration].every(value => Number.isFinite(value) && value > 0)
    || Math.abs(pictureDuration - duration) > frameSeconds + 1 / 16000
    || Math.abs(audioDuration - duration) > audioTolerance
    || Math.abs(mediaDuration - duration) > Math.max(frameSeconds, audioTolerance) + .002)
    throw Error('audio_review_synchronized_media_duration_invalid');
  return mediaDuration;
}
function reviewInputBudget(payload, duration, mediaDuration, identity) {
  const textOnly = structuredClone(payload); for (const item of textOnly.input) delete item.data;
  const components = {submitted_text_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(textOnly)) / 3),
    wrapper_allowance_tokens: 512, video_tokens: Math.ceil(Math.max(duration, mediaDuration) * 300),
    audio_tokens: Math.ceil(identity.samples / 16000 * 32), video_audio_tokens: Math.ceil(mediaDuration * 32)};
  return {revision: 'static-mix-audio-picture-planning-v1', components,
    submitted_input_tokens: Object.values(components).reduce((sum, count) => sum + count, 0),
    estimate_is_provider_usage: false, guaranteed_provider_token_ceiling: false,
    excludes_output_schema: false, includes_video_audio: true, base64_counted_as_text: false};
}
async function verifyPreparedAudioIdentity(identity, job) {
  const samples = Math.round(job.source_range[1] * 16000) - Math.round(job.source_range[0] * 16000);
  if ((await stat(identity.input_audio.path)).size !== 44 + samples * 4) throw Error('audio_review_prepared_audio_identity_invalid');
  const bytes = await readFile(identity.input_audio.path);
  if (bytes.length !== 44 + samples * 4 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.readUInt32LE(4) !== bytes.length - 8
    || bytes.toString('ascii',8,16) !== 'WAVEfmt ' || bytes.readUInt32LE(16) !== 16 || bytes.readUInt16LE(20) !== 3
    || bytes.readUInt16LE(22) !== 1 || bytes.readUInt32LE(24) !== 16000 || bytes.readUInt32LE(28) !== 64000
    || bytes.readUInt16LE(32) !== 4 || bytes.readUInt16LE(34) !== 32 || bytes.toString('ascii',36,40) !== 'data'
    || bytes.readUInt32LE(40) !== samples * 4 || samples < 1 || shaBytes(bytes) !== identity.input_audio.sha256
    || identity.samples !== samples || identity.input_audio.samples !== samples
    || identity.sample_rate_hz !== 16000 || identity.input_audio.sample_rate_hz !== 16000
    || identity.pcm_sha256 !== shaBytes(bytes.subarray(44)) || identity.input_audio.pcm_sha256 !== identity.pcm_sha256
    || identity.source_path !== path.resolve(job.path) || identity.source_sha256 !== job.source_sha256
    || identity.input_audio.source_sha256 !== job.source_sha256 || !sameJson(identity.source_range, job.source_range)
    || !sameJson(identity.input_audio.source_range, job.source_range)
    || identity.segment_id !== job.segment_id || identity.asset_id !== job.asset_id)
    throw Error('audio_review_prepared_audio_identity_invalid');
  for (let offset = 44; offset < bytes.length; offset += 4) if (!Number.isFinite(bytes.readFloatLE(offset)))
    throw Error('audio_review_prepared_audio_identity_invalid');
}
async function checkedPrepared(session, job, out, options, prepared) {
  strictBinding(prepared?.preparation);
  if (path.resolve(prepared.preparation.path) !== path.join(out, 'prepared-request.json'))
    throw Error('audio_review_prepared_request_required');
  await verifyEvidenceBindings(prepared.preparation);
  const value = await readJson(prepared.preparation.path);
  strictBinding(value.request_payload); strictBinding(value.identity?.input_audio); strictBinding(value.options?.video);
  finiteJson(value.input_budget);
  if (!Number.isSafeInteger(value.input_budget?.submitted_input_tokens) || value.input_budget.submitted_input_tokens < 1
    || !value.input_budget.components || Object.values(value.input_budget.components).some(count => !Number.isSafeInteger(count) || count < 0)
    || Object.values(value.input_budget.components).reduce((sum, count) => sum + count, 0) !== value.input_budget.submitted_input_tokens
    || value.input_budget.estimate_is_provider_usage !== false || value.input_budget.guaranteed_provider_token_ceiling !== false)
    throw Error('audio_review_input_budget_binding_invalid');
  const expected = {schema_version: 1, contract: reviewContract, request_payload: value.request_payload,
    request_body_sha256: value.request_body_sha256, input_budget: value.input_budget,
    timeout_ms: value.timeout_ms, preparation: prepared.preparation};
  if (!sameJson(prepared, expected) || value.contract !== reviewContract || value.schema_version !== 1
    || !sameJson(value.job, reviewJob(job)) || !sameJson(value.options, reviewOptions(options))
    || !sameJson(value.backend, reviewBackend(session.audioBackend))
    || value.timeout_ms !== positiveTimeout(session.timeoutMs)
    || path.resolve(value.identity?.input_audio?.path ?? '') !== path.join(out, 'input.wav')
    || path.resolve(value.request_payload?.path ?? '') !== path.join(out, 'request-payload.json'))
    throw Error('audio_review_prepared_identity_changed');
  await verifyEvidenceBindings([value.request_payload, value.identity.input_audio, value.options.video]);
  if (await hashFile(job.path) !== job.source_sha256) throw Error('audio_review_prepared_source_changed');
  await verifyPreparedAudioIdentity(value.identity, job);
  const payload = await readJson(value.request_payload.path), body = JSON.stringify(payload);
  if (shaBytes(body) !== value.request_body_sha256) throw Error('audio_review_prepared_payload_changed');
  const mediaDuration = await reviewMedia(value.options.video, job.source_range[1] - job.source_range[0]);
  const inputs = payload.input, prompt = mixPrompt(value.options.context);
  if (!Array.isArray(inputs) || inputs.length !== 3 || inputs[0].type !== 'text' || inputs[0].text !== prompt || value.prompt !== prompt
    || inputs[1].type !== 'audio' || inputs[1].mime_type !== 'audio/wav' || typeof inputs[1].data !== 'string'
    || shaBytes(Buffer.from(inputs[1].data, 'base64')) !== value.identity.input_audio.sha256
    || inputs[2].type !== 'video' || inputs[2].mime_type !== 'video/mp4' || typeof inputs[2].data !== 'string'
    || shaBytes(Buffer.from(inputs[2].data, 'base64')) !== value.options.video.sha256
    || !sameJson(inputs[2].processing, {type:'static',fps:1}) || inputs[2].resolution !== 'low'
    || !sameJson(payload.generation_config, {max_output_tokens:8192,thinking_level:'high'})
    || !sameJson(payload.response_format, {type:'text',mime_type:'application/json',schema:audioSchema})
    || payload.model !== value.backend.model_revision || payload.store !== false
    || !sameJson(Object.keys(payload).sort(), ['generation_config','input','model','response_format','store'])
    || !sameJson(value.input_budget, reviewInputBudget(payload, job.source_range[1] - job.source_range[0], mediaDuration, value.identity)))
    throw Error('audio_review_prepared_contract_changed');
  return {value, payload, body};
}

export class ApiSession {
  constructor({ budget, directory, environment = process.env, transport = fetch, timeoutMs = 120000, audioBackend }) {
    this.budget = budget; this.directory = path.resolve(directory); this.environment = environment;
    this.transport = transport; this.timeoutMs = timeoutMs; this.ledger = [];
    this.audioBackend = resolveAudioBackend(audioBackend);
  }
  get audioReviewEvidenceContract() { return audioBackendMatches(this.audioBackend, DEFAULT_AUDIO_BACKEND) ? reviewContract : null; }
  async prepareAudioReviewRequest(job, outputDirectory, options = {}) {
    const out = path.resolve(outputDirectory), normalizedJob = reviewJob(job), normalizedOptions = reviewOptions(options);
    const backend = reviewBackend(this.audioBackend), timeout_ms = positiveTimeout(this.timeoutMs);
    const preparationFile = path.join(out, 'prepared-request.json');
    try {
      const files = await readdir(out);
      if (!files.includes('prepared-request.json')) throw Error('audio_review_incomplete_preparation_requires_reconciliation');
      const binding = {path: preparationFile, sha256: await hashFile(preparationFile)}, value = await readJson(preparationFile);
      const prepared = {schema_version: 1, contract: reviewContract, request_payload: value.request_payload,
        request_body_sha256: value.request_body_sha256, input_budget: value.input_budget,
        timeout_ms: value.timeout_ms, preparation: binding};
      await checkedPrepared(this, job, out, options, prepared); return prepared;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!sameJson(normalizedOptions.video.source_range, normalizedJob.source_range)
      || await hashFile(normalizedOptions.video.path) !== normalizedOptions.video.sha256)
      throw Error('synchronized_video_binding_invalid');
    const duration = normalizedJob.source_range[1] - normalizedJob.source_range[0];
    const mediaDuration = await reviewMedia(normalizedOptions.video, duration);
    await mkdir(path.dirname(out), {recursive: true}); await mkdir(out);
    const identity = await prepareApiAudio(normalizedJob, path.join(out, 'input.wav'));
    const audioBytes = await readFile(identity.input_audio.path), videoBytes = await readFile(normalizedOptions.video.path);
    if (shaBytes(audioBytes) !== identity.input_audio.sha256 || shaBytes(videoBytes) !== normalizedOptions.video.sha256)
      throw Error('audio_review_media_changed_during_prepare');
    const prompt = mixPrompt(normalizedOptions.context);
    const payload = {model: backend.model_revision, store: false, input: [
      {type: 'text', text: prompt}, {type: 'audio', mime_type: 'audio/wav', data: audioBytes.toString('base64')},
      {type: 'video', mime_type: 'video/mp4', data: videoBytes.toString('base64'),
        processing: normalizedOptions.processing, resolution: normalizedOptions.resolution}],
      generation_config: {max_output_tokens: 8192, thinking_level: 'high'},
      response_format: {type: 'text', mime_type: 'application/json', schema: audioSchema}};
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 20 * 1024 * 1024) throw Error('gemini_inline_request_exceeds_20mb');
    const input_budget = reviewInputBudget(payload, duration, mediaDuration, identity);
    const request_payload = await saveJson(path.join(out, 'request-payload.json'), payload);
    const request_body_sha256 = shaBytes(body);
    const preparation = await saveJson(preparationFile, {schema_version: 1, contract: reviewContract,
      job: normalizedJob, options: normalizedOptions, backend, identity, prompt, request_payload,
      request_body_sha256, input_budget, timeout_ms});
    const prepared = {schema_version: 1, contract: reviewContract, request_payload, request_body_sha256,
      input_budget, timeout_ms, preparation};
    await checkedPrepared(this, job, out, options, prepared); return prepared;
  }
  async post(provider, payload, stage, audioBackend = null, options = {}) {
    if (!['openai', 'gemini'].includes(provider)) throw new Error('unsupported_api_provider');
    if (audioBackend && (provider !== 'gemini' || resolveAudioBackend(audioBackend).protocol !== 'gemini_interactions'
      || payload.model !== resolveAudioBackend(audioBackend).model_revision))
      throw new Error('audio_backend_request_identity_mismatch');
    const b = this.budget;
    if (b?.enabled !== true || !Number.isSafeInteger(b.max_calls) || b.max_calls < 1
      || !(b.max_estimated_cost_usd > 0) || !(b.per_call_cost_ceiling_usd > 0)
      || !Number.isFinite(b.max_estimated_cost_usd) || !Number.isFinite(b.per_call_cost_ceiling_usd)) throw new Error('api_budget_not_configured');
    const reserved = this.ledger.reduce((sum, row) => sum + row.cost_ceiling_usd, 0);
    if (this.ledger.length >= b.max_calls || reserved + b.per_call_cost_ceiling_usd > b.max_estimated_cost_usd + 1e-9) throw new Error('budget_exhausted');
    const key = provider === 'openai' ? this.environment.OPENAI_API_KEY : this.environment.GEMINI_API_KEY || this.environment.GOOGLE_API_KEY;
    if (!key?.trim()) throw new Error(`missing_${provider}_credential`);
    const timeoutMs = Math.min(positiveTimeout(this.timeoutMs), positiveTimeout(options.timeoutMs ?? this.timeoutMs));
    const body = options.serializedBody ?? JSON.stringify(payload);
    if (typeof body !== 'string' || body !== JSON.stringify(payload)) throw Error('request_serialization_binding_invalid');
    if (provider === 'gemini' && Buffer.byteLength(body) > 20 * 1024 * 1024) throw new Error('gemini_inline_request_exceeds_20mb');
    const ordinal = this.ledger.length + 1, row = { ordinal, provider, model: payload.model, stage,
      cost_ceiling_usd: b.per_call_cost_ceiling_usd, request_body_sha256: shaBytes(body), status: 'submitted', usage: null, timeout_ms: timeoutMs,
      ...(audioBackend ? resolveAudioBackend(audioBackend) : {}) };
    this.ledger.push(row);
    await saveJson(path.join(this.directory, `${ordinal}-submission.json`), row);
    const began = performance.now(), controller = new AbortController(); let deadlineTimer, responseValue;
    const deadline = new Promise((_resolve, reject) => {deadlineTimer = setTimeout(() => {
      controller.abort(); reject(Error('provider_timeout'));
    }, timeoutMs);});
    try {
      const result = await Promise.race([Promise.resolve().then(() => this.transport(provider === 'openai' ? 'https://api.openai.com/v1/responses'
        : 'https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(provider === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }) },
        body, signal: controller.signal,
      })), deadline]);
      if (!result.ok) throw new Error(`provider_http_${result.status}`);
      const raw = JSON.parse(redact(JSON.stringify(await Promise.race([result.json(), deadline])), this.environment));
      const rawBinding = await saveJson(path.join(this.directory, `${ordinal}-response.json`), raw);
      row.response = rawBinding; row.request_id = raw.id; row.status = raw.status; row.usage = raw.usage ?? null;
      if (!raw.id || raw.status !== 'completed') throw new Error('provider_response_not_completed');
      if (audioBackend && raw.model !== audioBackend.model_revision) throw new Error('provider_model_revision_mismatch');
      if ((raw.output ?? raw.steps ?? []).some(item => item.status && item.status !== 'completed')) throw new Error('provider_output_not_completed');
      const outputs = provider === 'openai' ? raw.output?.flatMap(item => item.content ?? [])
        : raw.steps?.filter(step => step.type === 'model_output').flatMap(step => step.content ?? []) ?? raw.outputs;
      if (!Array.isArray(outputs) || outputs.some(item => item.type === 'refusal')) throw new Error('provider_text_response_required');
      const output = outputs.filter(item => ['text', 'output_text'].includes(item.type)).map(item => item.text).join('');
      if (!output.trim()) throw new Error('provider_text_response_required');
      const value = JSON.parse(output);
      if (payload.text?.format?.schema) validateSchema(value, payload.text.format.schema);
      if (payload.response_format?.schema) validateSchema(value, payload.response_format.schema);
      responseValue = { value, request_id: raw.id, model: raw.model || payload.model, finish_reason: 'complete', raw_response: rawBinding,
        raw_response_sha256: rawBinding.sha256, usage: row.usage,
        provider, purpose: stage, request_body_sha256: row.request_body_sha256,
        ...(audioBackend ? resolveAudioBackend(audioBackend) : {}) };
    } catch (error) {
      row.status = error.message?.startsWith('provider_http_') ? 'provider_rejected'
        : error instanceof SyntaxError ? 'invalid_json_response' : row.response ? 'invalid_response' : 'provider_outcome_unknown';
      // Do not retry a request whose external outcome is unknown or echo SDK/network errors.
      throw new Error(error.message === 'budget_exhausted' ? error.message : `${provider}_${row.status}`);
    } finally {
      clearTimeout(deadlineTimer);
      row.elapsed_seconds = (performance.now() - began) / 1000;
      const receipt = await saveJson(path.join(this.directory, `${ordinal}-receipt.json`), row);
      if (responseValue) responseValue.submission_receipt = receipt;
    }
    return responseValue;
  }
  async director({ prompt, data, frames = [], schema = null, stage = 'director', effort = 'high' }) {
    const content = [{ type: 'input_text', text: JSON.stringify(data) }];
    for (const frame of frames) {
      if (frame.sha256 && await hashFile(frame.path) !== frame.sha256) throw new Error('frame_changed_before_submission');
      const bytes = await readFile(frame.path);
      content.push({ type: 'input_text', text: `frame_id=${frame.id}; timeline_seconds=${frame.timeline_seconds}` },
        { type: 'input_image', image_url: `data:image/${path.extname(frame.path).toLowerCase() === '.png' ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}` });
    }
    return this.post('openai', { model: 'gpt-6.1-sol', store: false, reasoning: { effort }, max_output_tokens: 16384,
      input: [{ role: 'developer', content: [{ type: 'input_text', text: prompt }] }, { role: 'user', content }],
      text: { format: schema ? { type: 'json_schema', name: stage.replace(/[^a-z0-9_]/gi, '_'), strict: true, schema }
        : { type: 'json_object' } } }, stage);
  }
  async observeAudio(job, outputDirectory, options = {}) {
    const { frames = [], video = null, purpose = 'candidate', context = null, prepared_request, timeoutMs } = options;
    if (purpose === 'mix') return this.observePreparedAudio(job, outputDirectory, options);
    const out = path.resolve(outputDirectory); await mkdir(out, { recursive: true });
    const identity = await prepareApiAudio(job, path.join(out, 'input.wav'));
    const prompt = 'Describe only this actual audio. Names and desired genre are deliberately absent. '
      + 'Report actual instruments, pulse and development; distinguish sung words, speech and wordless voice. '
      + (purpose === 'original' ? 'Transcribe the clearly audible dialogue in complete utterances with start/end times; mark uncertain utterances. '
        : 'Transcribe only short words you clearly hear; uncertainty is allowed. ')
      + 'All times are relative to the submitted clip. '
      + 'Do not invent words in silence or instrumental music. Stereo and sample-accurate sync are checked elsewhere. '
      + (purpose === 'words_candidate' ? 'Check one actually complete sung phrase: report its actual words, audible start and end, and whether the phrase is cut at either clip boundary. If unsure or not sung, complete_phrase=false; never infer completeness from a lyric text. ' : '')
      + (purpose === 'mix' ? 'With the supplied synchronized frames, check narrative fit, audible accents, dialogue masking and music transitions. ' : '')
      + (context && purpose === 'mix' ? `Task context for picture review only: ${JSON.stringify(context)}` : '');
    const audioBytes = await readFile(identity.input_audio.path);
    if (shaBytes(audioBytes) !== identity.input_audio.sha256) throw new Error('submitted_audio_changed');
    const input = [{ type: 'text', text: prompt }, { type: 'audio', mime_type: 'audio/wav', data: audioBytes.toString('base64') }];
    if (video) {
      if (await hashFile(video.path) !== video.sha256 || JSON.stringify(video.source_range) !== JSON.stringify(job.source_range)) throw new Error('synchronized_video_binding_invalid');
      const videoBytes = await readFile(video.path);
      if (shaBytes(videoBytes) !== video.sha256) throw new Error('synchronized_video_binding_invalid');
      input.push({ type: 'text', text: 'This video has the same synchronized audio and relative zero point as the audio clip. Treat it as one scene.' },
        { type: 'video', mime_type: 'video/mp4', data: videoBytes.toString('base64') });
    }
    for (const frame of frames) {
      if (frame.sha256 && await hashFile(frame.path) !== frame.sha256) throw new Error('frame_changed_before_submission');
      const frameBytes = await readFile(frame.path);
      if (frame.sha256 && shaBytes(frameBytes) !== frame.sha256) throw new Error('frame_changed_before_submission');
      input.push({ type: 'text', text: `clip_seconds=${frame.timeline_seconds - job.source_range[0]}` },
        { type: 'image', mime_type: path.extname(frame.path).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          data: frameBytes.toString('base64') });
    }
    const response = await this.post('gemini', { model: this.audioBackend.model_revision, input,
      generation_config: { max_output_tokens: 8192, thinking_level: 'high' },
      response_format: { type: 'text', mime_type: 'application/json', schema: purpose === 'words_candidate' ? audioWordsSchema : audioSchema } }, purpose, this.audioBackend, {timeoutMs});
    await verifyEvidenceBindings([identity.input_audio, ...(video ? [video] : []), ...frames]);
    if (await hashFile(job.path) !== job.source_sha256) throw new Error('audio_source_changed_after_submission');
    const observation = response.value, duration = job.source_range[1] - job.source_range[0];
    for (const item of [...observation.words, ...observation.issues]) {
      if (!(item.start_seconds >= 0 && item.end_seconds > item.start_seconds && item.end_seconds <= duration + 1 / 16000)) throw new Error('audio_observation_time_out_of_range');
    }
    if (observation.changes.some(item => item.time_seconds < 0 || item.time_seconds > duration)) throw new Error('audio_change_time_out_of_range');
    const audit = await saveJson(path.join(out, 'api-evidence.json'), { schema_version: 1, ...response, value: undefined,
      audio_sha256: identity.input_audio.sha256, submitted_pcm_sha256: identity.pcm_sha256,
      source_sha256: job.source_sha256, source_window: job.source_range });
    const record = { schema_version: 1, ...identity, source_video_sha256: job.source_video_sha256 ?? null,
      ...this.audioBackend,
      actual_audio_processed: true, model: response.model, request_id: response.request_id,
      observation, raw_observation: observation.description, api_evidence: audit,
      execution: { backend_kind: 'api', actual_audio_processed: true, model: response.model, request_id: response.request_id,
        ...this.audioBackend,
        audio_sha256: identity.input_audio.sha256, submitted_pcm_sha256: identity.pcm_sha256, source_window: job.source_range },
      completion_status: 'complete', finish_reason: 'complete', qualified: false, scopes: [], selected: false,
      artistic_approval: false, warnings: ['api_observation_not_artistic_approval'],
      cache_key: shaBytes(JSON.stringify({ ...this.audioBackend, model: response.model, source_sha256: job.source_sha256,
        source_video_sha256: job.source_video_sha256 ?? null, synchronized_video_sha256: video?.sha256 ?? null,
        frames: frames.map(frame => [frame.sha256, frame.timeline_seconds]),
        source_range: job.source_range, pcm_sha256: identity.pcm_sha256, prompt })), cache_hit: false,
      observation_prompt_sha256: shaBytes(prompt), purpose, ...(video ? { synchronized_video: video } : {}) };
    record.file = await saveJson(path.join(out, 'observation.json'), record);
    return record;
  }
  async observePreparedAudio(job, outputDirectory, options) {
    const out = path.resolve(outputDirectory), prepared = options.prepared_request;
    const {value, payload, body} = await checkedPrepared(this, job, out, options, prepared);
    const timeoutMs = Math.min(positiveTimeout(this.timeoutMs), positiveTimeout(options.timeoutMs ?? prepared.timeout_ms));
    const {identity} = value, video = value.options.video;
    const files = await readdir(out);
    if (files.includes('observation.json')) {
      const file = {path: path.join(out, 'observation.json'), sha256: await hashFile(path.join(out, 'observation.json'))};
      const stored = await readJson(file.path);
      for (const ref of [stored.request_payload, stored.submission_receipt, stored.api_evidence, stored.preparation]) strictBinding(ref);
      await verifyEvidenceBindings(stored);
      const audit = await readJson(stored.api_evidence.path), receipt = await readJson(stored.submission_receipt.path);
      strictBinding(audit.raw_response); await verifyEvidenceBindings([audit, receipt]);
      const raw = await readJson(audit.raw_response.path);
      const text = (raw.steps?.filter(row => row.type === 'model_output').flatMap(row => row.content ?? []) ?? raw.outputs ?? [])
        .filter(row => ['text','output_text'].includes(row.type)).map(row => row.text).join('');
      if (!sameJson(stored.request_payload, prepared.request_payload) || !sameJson(stored.preparation, prepared.preparation)
        || !audioBackendMatches(stored, this.audioBackend) || !audioBackendMatches(audit, this.audioBackend)
        || !audioBackendMatches(receipt, this.audioBackend)
        || Object.entries(identity).some(([key, expected]) => !sameJson(stored[key], expected))
        || stored.request_body_sha256 !== prepared.request_body_sha256 || !sameJson(stored.input_audio, identity.input_audio)
        || !sameJson(stored.synchronized_video, video) || stored.source_sha256 !== job.source_sha256
        || stored.source_video_sha256 !== (job.source_video_sha256 ?? null) || !sameJson(stored.source_range, job.source_range)
        || stored.model !== this.audioBackend.model_revision || stored.purpose !== 'mix' || stored.actual_audio_processed !== true
        || stored.completion_status !== 'complete' || stored.finish_reason !== 'complete'
        || receipt.provider !== 'gemini' || receipt.stage !== 'mix' || receipt.status !== 'completed'
        || receipt.request_id !== stored.request_id || receipt.model !== stored.model
        || receipt.request_body_sha256 !== prepared.request_body_sha256 || !sameJson(receipt.response, audit.raw_response)
        || audit.provider !== 'gemini' || audit.purpose !== 'mix' || audit.request_id !== stored.request_id
        || audit.model !== stored.model || audit.request_body_sha256 !== prepared.request_body_sha256
        || audit.audio_sha256 !== identity.input_audio.sha256 || audit.submitted_pcm_sha256 !== identity.pcm_sha256
        || audit.source_sha256 !== job.source_sha256 || !sameJson(audit.source_window, job.source_range)
        || audit.finish_reason !== 'complete' || !sameJson(audit.preparation, prepared.preparation)
        || !sameJson(audit.request_payload, prepared.request_payload) || !sameJson(audit.submission_receipt, stored.submission_receipt)
        || raw.id !== stored.request_id || raw.model !== stored.model || raw.status !== 'completed'
        || (raw.steps ?? []).some(row => row.status && row.status !== 'completed')
        || (raw.steps?.filter(row => row.type === 'model_output').flatMap(row => row.content ?? []) ?? raw.outputs ?? []).some(row => row.type === 'refusal')
        || !text.trim() || !sameJson(JSON.parse(text), stored.observation)) throw Error('audio_review_cached_evidence_mismatch');
      validateSchema(stored.observation, audioSchema);
      const duration = job.source_range[1] - job.source_range[0];
      if ([...stored.observation.words, ...stored.observation.issues].some(item => item.start_seconds < 0
        || item.end_seconds <= item.start_seconds || item.end_seconds > duration + 1 / 16000)
        || stored.observation.changes.some(item => item.time_seconds < 0 || item.time_seconds > duration))
        throw Error('audio_review_cached_evidence_range_invalid');
      await verifyEvidenceBindings(file); return {...stored, file};
    }
    if (files.includes('submission-pending.json')) throw Error('audio_review_pending_submission_requires_reconciliation');
    await saveJson(path.join(out, 'submission-pending.json'), {schema_version: 1, contract: reviewContract,
      request_payload: prepared.request_payload, preparation: prepared.preparation,
      request_body_sha256: prepared.request_body_sha256, timeout_ms: timeoutMs,
      status: 'outcome_requires_reconciliation_until_bound_observation_complete'});
    const response = await this.post('gemini', payload, 'mix', this.audioBackend, {timeoutMs, serializedBody: body});
    await checkedPrepared(this, job, out, options, prepared);
    const observation = response.value, duration = job.source_range[1] - job.source_range[0];
    for (const item of [...observation.words, ...observation.issues]) {
      if (!(item.start_seconds >= 0 && item.end_seconds > item.start_seconds && item.end_seconds <= duration + 1 / 16000))
        throw Error('audio_observation_time_out_of_range');
    }
    if (observation.changes.some(item => item.time_seconds < 0 || item.time_seconds > duration)) throw Error('audio_change_time_out_of_range');
    const audit = await saveJson(path.join(out, 'api-evidence.json'), {schema_version: 1, ...response, value: undefined,
      request_payload: prepared.request_payload, preparation: prepared.preparation,
      audio_sha256: identity.input_audio.sha256, submitted_pcm_sha256: identity.pcm_sha256,
      source_sha256: job.source_sha256, source_window: job.source_range});
    const record = {schema_version: 1, ...identity, ...this.audioBackend, source_video_sha256: job.source_video_sha256 ?? null,
      actual_audio_processed: true, model: response.model, request_id: response.request_id,
      observation, raw_observation: observation.description, api_evidence: audit,
      request_payload: prepared.request_payload, submission_receipt: response.submission_receipt,
      preparation: prepared.preparation, request_body_sha256: prepared.request_body_sha256,
      execution: {backend_kind: 'api', actual_audio_processed: true, model: response.model, request_id: response.request_id,
        ...this.audioBackend, audio_sha256: identity.input_audio.sha256, submitted_pcm_sha256: identity.pcm_sha256,
        request_body_sha256: prepared.request_body_sha256, source_window: job.source_range},
      completion_status: 'complete', finish_reason: 'complete', qualified: false, scopes: [], selected: false,
      artistic_approval: false, warnings: ['api_observation_not_artistic_approval'],
      cache_key: prepared.request_body_sha256, cache_hit: false, observation_prompt_sha256: shaBytes(value.prompt),
      purpose: 'mix', synchronized_video: video};
    record.file = await saveJson(path.join(out, 'observation.json'), record); return record;
  }
}

export async function prepareApiAudio(job, outputFile) {
  const window = job.source_range;
  if (!Array.isArray(window) || window.length !== 2 || !window.every(Number.isFinite)
    || window[0] < 0 || window[1] <= window[0] || window[1] - window[0] > 180) throw new Error('bounded_api_audio_window_required');
  if (await hashFile(job.path) !== job.source_sha256) throw new Error('audio_source_changed');
  const first = Math.round(window[0] * 16000), last = Math.round(window[1] * 16000);
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '2', '-i', job.path,
    '-map', '0:a:0', '-af', `aresample=16000,atrim=start_sample=${first}:end_sample=${last},asetpts=PTS-STARTPTS`,
    '-ar', '16000', '-ac', '1', '-f', 'f32le', 'pipe:1'],
  { windowsHide: true, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
  const samples = stdout.length / 4;
  if (!Number.isInteger(samples) || samples !== last - first || samples < 1) throw new Error('decoded_api_audio_length_mismatch');
  let peak = 0, sum = 0;
  for (let i = 0; i < stdout.length; i += 4) { const value = stdout.readFloatLE(i); if (!Number.isFinite(value)) throw new Error('nonfinite_audio'); peak = Math.max(peak, Math.abs(value)); }
  const gain = peak > .85 ? .85 / peak : 1;
  for (let i = 0; i < stdout.length; i += 4) { const value = stdout.readFloatLE(i) * gain; stdout.writeFloatLE(value, i); sum += value * value; }
  const pcmSha = shaBytes(stdout), header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(stdout.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(64000, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(stdout.length, 40);
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(outputFile, Buffer.concat([header, stdout]), { flag: 'wx' });
  if (await hashFile(job.path) !== job.source_sha256) throw new Error('audio_changed_during_prepare');
  return { segment_id: job.segment_id, asset_id: job.asset_id, source_path: path.resolve(job.path),
    source_sha256: job.source_sha256, source_range: window, sample_rate_hz: 16000, samples,
    gain_applied: gain, pcm_sha256: pcmSha, signal: { exact_zero: peak === 0, peak: peak * gain, rms: Math.sqrt(sum / samples) },
    input_audio: { path: path.resolve(outputFile), sha256: await hashFile(outputFile), samples, sample_rate_hz: 16000,
      pcm_sha256: pcmSha, source_sha256: job.source_sha256, source_range: window } };
}
