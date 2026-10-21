import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

export class ApiSession {
  constructor({ budget, directory, environment = process.env, transport = fetch, timeoutMs = 120000, audioBackend }) {
    this.budget = budget; this.directory = path.resolve(directory); this.environment = environment;
    this.transport = transport; this.timeoutMs = timeoutMs; this.ledger = [];
    this.audioBackend = resolveAudioBackend(audioBackend);
  }
  async post(provider, payload, stage, audioBackend = null) {
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
    const body = JSON.stringify(payload);
    if (provider === 'gemini' && Buffer.byteLength(body) > 20 * 1024 * 1024) throw new Error('gemini_inline_request_exceeds_20mb');
    const ordinal = this.ledger.length + 1, row = { ordinal, provider, model: payload.model, stage,
      cost_ceiling_usd: b.per_call_cost_ceiling_usd, request_body_sha256: shaBytes(body), status: 'submitted', usage: null,
      ...(audioBackend ? resolveAudioBackend(audioBackend) : {}) };
    this.ledger.push(row);
    await saveJson(path.join(this.directory, `${ordinal}-submission.json`), row);
    const began = performance.now();
    try {
      const result = await this.transport(provider === 'openai' ? 'https://api.openai.com/v1/responses'
        : 'https://generativelanguage.googleapis.com/v1beta/interactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          ...(provider === 'openai' ? { Authorization: `Bearer ${key}` } : { 'x-goog-api-key': key }) },
        body, signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!result.ok) throw new Error(`provider_http_${result.status}`);
      const raw = JSON.parse(redact(JSON.stringify(await result.json()), this.environment));
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
      return { value, request_id: raw.id, model: raw.model || payload.model, finish_reason: 'complete', raw_response: rawBinding,
        raw_response_sha256: rawBinding.sha256, usage: row.usage,
        ...(audioBackend ? resolveAudioBackend(audioBackend) : {}) };
    } catch (error) {
      row.status = error.message?.startsWith('provider_http_') ? 'provider_rejected'
        : error instanceof SyntaxError ? 'invalid_json_response' : row.response ? 'invalid_response' : 'provider_outcome_unknown';
      // Do not retry a request whose external outcome is unknown or echo SDK/network errors.
      throw new Error(error.message === 'budget_exhausted' ? error.message : `${provider}_${row.status}`);
    } finally {
      row.elapsed_seconds = (performance.now() - began) / 1000;
      await saveJson(path.join(this.directory, `${ordinal}-receipt.json`), row);
    }
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
  async observeAudio(job, outputDirectory, { frames = [], video = null, purpose = 'candidate', context = null } = {}) {
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
      response_format: { type: 'text', mime_type: 'application/json', schema: purpose === 'words_candidate' ? audioWordsSchema : audioSchema } }, purpose, this.audioBackend);
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
