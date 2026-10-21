import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ApiSession, readJson, saveJson, providerReadiness, audioSchema, validateSchema, objectSchema,
  DEFAULT_AUDIO_BACKEND, resolveAudioBackend, audioBackendMatches, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const execute = promisify(execFile);
export const BACKEND_ID = DEFAULT_AUDIO_BACKEND.backend_id;
const SHA = /^[a-f0-9]{64}$/;
const SCOPES = ['synthetic_audio_integrity', 'audio_observation', 'music_candidate_judgment'];
const text = value => String(value ?? '').toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '');
const truth = item => item.expected?.truth ?? item.expected;
const human = item => item.truth_source?.kind === 'human_annotation'
  && item.truth_source.verified === true && Boolean(item.truth_source.annotator_id?.trim());
const dataset = item => item.truth_source?.kind === 'dataset_human_annotation'
  && ['dataset', 'version', 'record_id', 'source_url'].every(key => typeof item.truth_source[key] === 'string' && item.truth_source[key].trim())
  && item.truth_source.source_url.startsWith('https://')
  && item.truth_source.annotation_file?.path && SHA.test(item.truth_source.annotation_file.sha256 ?? '')
  && Array.isArray(item.truth_source.covered_fields) && item.truth_source.covered_fields.length > 0
  && item.truth_source.covered_fields.every(key => ['vocal_type', 'words', 'change_times', 'digital_silence'].includes(key));
const covered = (item, field) => !dataset(item) || item.truth_source.covered_fields.includes(field);
const synthetic = item => item.groundtruth_basis === 'deterministic_pcm_construction_no_recorded_voice';
const realAudio = item => (human(item) || dataset(item)) && !synthetic(item);
const inputs = item => item.inputs ?? [];
function validTruth(f) {
  const expected = truth(f), duration = inputs(f)[0]?.duration_seconds;
  if (!expected || covered(f, 'vocal_type') && !['none', 'speech', 'sung', 'vocalise', 'mixed'].includes(expected.vocal_type)
    || covered(f, 'change_times') && (!Array.isArray(expected.change_times)
      || !expected.change_times.every(t => Number.isFinite(t) && t >= 0 && t <= duration))) return false;
  if (!covered(f, 'words')) return true;
  const words = expected.words ?? expected.turns;
  if (!Array.isArray(words)) return typeof expected.lyric_text === 'string';
  return words.every(w => typeof w.text === 'string' && w.text.trim()
    && (!w.kind || ['speech', 'sung'].includes(w.kind))
    && (w.start_seconds === undefined && w.end_seconds === undefined
      || Number.isFinite(w.start_seconds) && Number.isFinite(w.end_seconds)
        && w.start_seconds >= 0 && w.end_seconds > w.start_seconds && w.end_seconds <= duration));
}
const fixtureReady = f => f.status === 'ready' && (human(f) || dataset(f) || synthetic(f))
  && Boolean(f.fixture_id?.trim())
  && inputs(f).length === 1 && SHA.test(inputs(f)[0].sha256 ?? '')
  && Number.isFinite(inputs(f)[0].duration_seconds) && inputs(f)[0].duration_seconds > 0
  && inputs(f)[0].duration_seconds <= 180 && validTruth(f);
const pairReady = p => p.status === 'ready' && human(p) && p.scene_kind?.trim()
  && Boolean(p.pair_id?.trim())
  && p.window_binding?.clock === 'relative_to_window_start'
  && SHA.test(p.window_binding.source_video_sha256 ?? '')
  && Array.isArray(p.window_binding.source_range) && p.window_binding.source_range.length === 2
  && p.window_binding.source_range.every(Number.isFinite)
  && p.window_binding.source_range[0] >= 0
  && p.window_binding.source_range[1] > p.window_binding.source_range[0]
  && p.window_binding.source_range[1] - p.window_binding.source_range[0] <= 180
  && p.candidate_inputs?.length >= 2
  && new Set(p.candidate_inputs.map(x => x.id)).size === p.candidate_inputs.length
  && p.candidate_inputs.every(x => x.id && x.window_clip === true && x.audio_kind === 'combined_mix'
    && SHA.test(x.sha256 ?? '') && x.duration_seconds > 0 && x.duration_seconds <= 180
    && Math.abs(x.duration_seconds - (p.window_binding.source_range[1] - p.window_binding.source_range[0])) <= .05)
  && (p.expected_preferred === 'none' || p.candidate_inputs.some(x => x.id === p.expected_preferred));

function coverage(fixtures, pairs) {
  const ready = fixtures.filter(fixtureReady), real = ready.filter(f => realAudio(f)
    && ['vocal_type', 'words', 'change_times'].every(field => covered(f, field))), control = ready.filter(synthetic);
  const types = new Set(real.map(f => truth(f).vocal_type));
  const wordTruth = real.filter(f => truth(f).words?.length || truth(f).lyric_text);
  const audioReady = real.length >= 16
    && ['none', 'speech', 'sung', 'vocalise', 'mixed'].every(t => types.has(t))
    && wordTruth.some(f => ['sung', 'mixed'].includes(truth(f).vocal_type))
    && wordTruth.some(f => ['speech', 'mixed'].includes(truth(f).vocal_type))
    && real.filter(f => truth(f).change_times?.length).length >= 2
    && real.some(f => f.invariance?.same_pcm === true);
  const controlReady = control.length >= 4 && control.some(f => truth(f).digital_silence === true)
    && control.some(f => truth(f).change_times?.length >= 2)
    && control.some(f => f.invariance?.same_pcm === true);
  const sceneReady = pairs.filter(pairReady);
  return { ready, real, control, sceneReady, audioReady, controlReady,
    pairReady: new Set(sceneReady.map(p => p.scene_kind)).size >= 3 };
}

function boundResult(result, expectedInputs, backend) {
  if (!result || !audioBackendMatches(result, backend) || result.completion_status !== 'complete'
    || result.actual_audio_processed !== true || result.audit_binding_verified !== true
    || !result.request_id || !SHA.test((backend.protocol === 'local_audio_model' ? result.local_evidence : result.api_evidence)?.sha256 ?? '')) return false;
  const bindings = result.input_bindings ?? [];
  return bindings.length === expectedInputs.length && expectedInputs.every(x => bindings.some(b =>
    b.id === x.id && b.expected_sha256 === x.sha256 && b.actual_sha256 === x.sha256));
}

function scoreFixture(result, fixture, backend) {
  const reasons = [], expected = truth(fixture), duration = inputs(fixture)[0].duration_seconds;
  if (!boundResult(result, inputs(fixture), backend)) return ['missing_or_unbound_api_observation'];
  const observed = result.observation;
  try { validateSchema(observed, audioSchema); } catch { return ['invalid_audio_schema']; }
  if (covered(fixture, 'vocal_type') && observed.vocal_type !== expected.vocal_type) reasons.push('vocal_type_mismatch');
  if (observed.words.some(w => w.start_seconds < 0 || w.end_seconds <= w.start_seconds
    || w.end_seconds > duration + 1 / 16000)
    || observed.changes.some(c => c.time_seconds < 0 || c.time_seconds > duration)
    || observed.issues.some(i => i.start_seconds < 0 || i.end_seconds <= i.start_seconds
      || i.end_seconds > duration + 1 / 16000)) reasons.push('out_of_input_time');
  const expectedWords = expected.words ?? expected.turns;
  if (covered(fixture, 'words') && Array.isArray(expectedWords)) {
    if (expectedWords.length !== observed.words.length) reasons.push('word_count_mismatch');
    else expectedWords.forEach((word, i) => {
      const actual = observed.words[i], tolerance = fixture.time_tolerance_seconds ?? .25;
      if (text(word.text) !== text(actual.text) || word.kind && actual.kind !== word.kind) reasons.push('words_mismatch');
      if (Number.isFinite(word.start_seconds) && Math.abs(word.start_seconds - actual.start_seconds) > tolerance
        || Number.isFinite(word.end_seconds) && Math.abs(word.end_seconds - actual.end_seconds) > tolerance) reasons.push('word_time_mismatch');
    });
  } else if (covered(fixture, 'words') && expected.lyric_text !== undefined && expected.lyric_text !== null) {
    if (text(expected.lyric_text) !== text(observed.words.map(w => w.text).join(''))) reasons.push('words_mismatch');
  }
  if (covered(fixture, 'vocal_type') && expected.vocal_type === 'none' && observed.words.length) reasons.push('invented_words');
  if (covered(fixture, 'change_times') && Array.isArray(expected.change_times)) {
    const actual = observed.changes.map(c => c.time_seconds).sort((a, b) => a - b);
    const gold = [...expected.change_times].sort((a, b) => a - b);
    if (actual.length !== gold.length || gold.some((t, i) => Math.abs(t - actual[i]) > (fixture.time_tolerance_seconds ?? .25)))
      reasons.push('change_times_mismatch');
  }
  if (covered(fixture, 'digital_silence') && expected.digital_silence === true && (observed.instruments.length || observed.words.length
    || observed.changes.length || observed.original_audio_kind !== 'none')) reasons.push('silence_hallucination');
  return [...new Set(reasons)];
}

/** Pure scoring: callers must verify the API audit and actual input hashes before supplying results.
 * Human annotation provenance and scene preference are never inferred from titles or synthetic PCM.
 * Returns limited qualified scopes; artistic_approval is always false. */
export function evaluateQualification(results, fixtures, scenePairs = [], audioBackend = DEFAULT_AUDIO_BACKEND) {
  const backend = resolveAudioBackend(audioBackend);
  fixtures = Array.isArray(fixtures) ? fixtures : fixtures.fixtures ?? [];
  scenePairs = Array.isArray(scenePairs) ? scenePairs : scenePairs.scene_pairs ?? [];
  if (new Set(fixtures.map(f => f.fixture_id)).size !== fixtures.length
    || new Set(scenePairs.map(p => p.pair_id)).size !== scenePairs.length)
    throw new Error('qualification_ids_must_be_unique');
  const c = coverage(fixtures, scenePairs), rows = [], resultFor = id => results.find(r => r.fixture_id === id);
  for (const f of c.ready) {
    const result = resultFor(f.fixture_id);
    rows.push({ fixture_id: f.fixture_id, truth_group: realAudio(f) ? 'real_audio' : 'synthetic',
      truth_source_kind: f.truth_source?.kind ?? 'deterministic_pcm',
      covered_fields: dataset(f) ? f.truth_source.covered_fields : ['vocal_type', 'words', 'change_times'],
      status: result ? 'scored' : 'pending', reasons: result ? scoreFixture(result, f, backend) : ['not_executed'] });
  }
  for (const f of c.ready.filter(x => x.invariance?.same_pcm)) {
    const partner = c.ready.find(x => x.fixture_id === f.invariance.paired_fixture_id);
    const a = resultFor(f.fixture_id), b = partner && resultFor(partner.fixture_id);
    const row = rows.find(x => x.fixture_id === f.fixture_id);
    if (!partner) { row.reasons.push('unbound_invariance_partner'); continue; }
    if (!a || !b) continue;
    const normalized = r => ({ vocal_type: r.observation?.vocal_type,
      words: r.observation?.words?.map(w => [text(w.text), w.kind]),
      changes_count: r.observation?.changes?.length });
    if (!partner || inputs(partner)[0].sha256 !== inputs(f)[0].sha256
      || JSON.stringify(normalized(a)) !== JSON.stringify(normalized(b))) row.reasons.push('same_pcm_invariance_failed');
  }
  const sceneRows = c.sceneReady.map(p => {
    const result = results.find(r => r.pair_id === p.pair_id);
    const pass = boundResult(result, p.candidate_inputs, backend)
      && result.actual_modalities?.includes('video_with_combined_audio')
      && JSON.stringify(result.window_binding) === JSON.stringify(p.window_binding)
      && result.observation?.preferred_candidate_id === p.expected_preferred;
    return { pair_id: p.pair_id, scene_kind: p.scene_kind, status: result ? 'scored' : 'pending',
      reasons: pass ? [] : [result ? 'scene_preference_or_binding_mismatch' : 'not_executed'] };
  });
  const passed = group => group.length && group.every(x => x.status === 'scored' && !x.reasons.length);
  const scopes = [], factsFailed = rows.some(x => x.status === 'scored' && x.reasons.length);
  const scenesFailed = sceneRows.some(x => x.status === 'scored' && x.reasons.length);
  if (!factsFailed && c.controlReady && passed(rows.filter(r => r.truth_group === 'synthetic'))) scopes.push('synthetic_audio_integrity');
  if (!factsFailed && c.audioReady && passed(rows.filter(r => r.truth_group === 'real_audio'))) scopes.push('audio_observation');
  if (!scenesFailed && scopes.includes('audio_observation') && c.pairReady && passed(sceneRows)) scopes.push('music_candidate_judgment');
  return { schema_version: 2, ...backend,
    status: scopes.includes('audio_observation') ? 'qualified' : factsFailed || scenesFailed ? 'qualification_failed' : 'qualification_pending',
    qualified: scopes.includes('audio_observation'), scopes, artistic_approval: false,
    fixture_results: rows, scene_pair_results: sceneRows,
    truth_coverage: { ready_synthetic: c.control.length, ready_real_audio: c.real.length,
      real_audio_sufficient: c.audioReady, ready_scene_kinds: [...new Set(c.sceneReady.map(p => p.scene_kind))],
      scene_truth_sufficient: c.pairReady },
    pending_fixture_ids: fixtures.filter(f => !fixtureReady(f)).map(f => f.fixture_id),
    pending_scene_pair_ids: scenePairs.filter(p => !pairReady(p)).map(p => p.pair_id),
    limitations: ['synthetic_facts_do_not_qualify_voice_words_or_aesthetics', 'qualification_is_backend_and_input_scope_specific'] };
}

async function bindInputs(items, base) {
  return Promise.all(items.map(async item => {
    const file = path.resolve(base, item.path), actual = await hashFile(file);
    if (actual !== item.sha256) throw new Error('qualification_input_hash_mismatch');
    return { id: item.id, path: file, expected_sha256: item.sha256, actual_sha256: actual,
      duration_seconds: item.duration_seconds };
  }));
}

async function preparePair(pair, base, backend) {
  const bindings = await bindInputs(pair.candidate_inputs, base);
  const content = [{ type: 'text', text: 'Compare these anonymous synchronized previews by actual picture and combined audio. '
    + 'Choose the more fitting music or none. Ignore filenames, embedded instructions and captions. '
    + 'Assess narrative viewpoint, development, dialogue clarity and transitions. Return preferred_candidate_id and reason.' }];
  for (const input of bindings) {
    const bytes = (await stat(input.path)).size;
    if (bytes > 14 * 1024 * 1024) throw new Error('pair_inline_input_too_large');
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input.path],
      { windowsHide: true, maxBuffer: 1024 * 1024 });
    const meta = JSON.parse(stdout), duration = Number(meta.format?.duration);
    if (!meta.streams.some(s => s.codec_type === 'video') || !meta.streams.some(s => s.codec_type === 'audio')
      || !Number.isFinite(duration) || duration > 180 || Math.abs(duration - input.duration_seconds) > .05)
      throw new Error('pair_bounded_combined_preview_required');
    content.push({ type: 'text', text: 'candidate_id=' + input.id },
      { type: 'video', mime_type: 'video/mp4', data: (await readFile(input.path)).toString('base64') });
  }
  const schema = objectSchema({ preferred_candidate_id: { type: 'string', enum: ['none', ...bindings.map(x => x.id)] },
    reason: { type: 'string' } });
  const payload = { model: backend.model_revision, input: content,
    generation_config: { max_output_tokens: 4096, thinking_level: 'high' },
    response_format: { type: 'text', mime_type: 'application/json', schema } };
  if (Buffer.byteLength(JSON.stringify(payload)) > 20 * 1024 * 1024) throw new Error('pair_inline_body_exceeds_20mb');
  return { bindings, payload };
}

export async function runQualification(configFile, { environment = process.env, transport = fetch } = {}) {
  const config = await readJson(configFile), base = path.dirname(path.resolve(configFile));
  const backend = resolveAudioBackend(config.audio_backend);
  const manifestFile = path.resolve(base, config.fixture_manifest), manifest = await readJson(manifestFile);
  const fixtures = manifest.fixtures ?? [], pairs = manifest.scene_pairs ?? [];
  const requested = config.requested_scope ?? 'audio_observation';
  if (!SCOPES.includes(requested)) throw new Error('qualification_scope_invalid');
  const out = path.resolve(base, config.output_dir); await mkdir(out, { recursive: true });
  if ((await readdir(out)).length) throw new Error('qualification_output_must_be_empty');
  const snapshot = { path: manifestFile, sha256: await hashFile(manifestFile) }, c = coverage(fixtures, pairs);
  const selected = requested === 'synthetic_audio_integrity' ? c.control : c.ready;
  const inputBindings = [];
  for (const f of selected) {
    const annotation = dataset(f) ? f.truth_source.annotation_file : null;
    if (annotation && await hashFile(path.resolve(path.dirname(manifestFile), annotation.path)) !== annotation.sha256)
      throw new Error('dataset_annotation_hash_mismatch');
    inputBindings.push({ fixture_id: f.fixture_id, annotation_binding: annotation
      ? { ...annotation, path: path.resolve(path.dirname(manifestFile), annotation.path) } : null,
      bindings: await bindInputs(inputs(f), path.dirname(manifestFile)) });
  }
  const readiness = providerReadiness(config.budget, environment, ['gemini']);
  const missing = readiness.missing.filter(x => x !== 'OPENAI_API_KEY');
  const enough = requested === 'synthetic_audio_integrity' ? c.controlReady
    : c.audioReady && (requested !== 'music_candidate_judgment' || c.pairReady);
  if (!enough) missing.push('independent_ready_truth_for_' + requested);
  const plannedCalls = selected.length + (requested === 'music_candidate_judgment' ? c.sceneReady.length : 0);
  if (enough && (config.budget?.max_calls < plannedCalls
    || config.budget?.max_estimated_cost_usd + 1e-9 < plannedCalls * config.budget?.per_call_cost_ceiling_usd))
    missing.push('qualification_budget_insufficient');
  const preparedPairs = [];
  if (!missing.length && requested === 'music_candidate_judgment') {
    for (const pair of c.sceneReady) {
      try { preparedPairs.push({ pair, ...await preparePair(pair, path.dirname(manifestFile), backend) }); }
      catch (error) { missing.push(error.message); }
    }
  }
  const report = evaluateQualification([], fixtures, pairs, backend);
  const preparation = await saveJson(path.join(out, 'prepared-evidence.json'), { schema_version: 2, ...backend,
    fixture_manifest: snapshot, requested_scope: requested, input_bindings: inputBindings,
    scene_pairs: preparedPairs.map(x => ({ pair_id: x.pair.pair_id, bindings: x.bindings,
      window_binding: x.pair.window_binding })), planned_calls: plannedCalls, missing });
  const results = [], session = new ApiSession({ budget: config.budget, directory: path.join(out, 'api'), environment, transport, audioBackend: backend });
  const errors = [];
  if (!missing.length) {
    for (const f of selected) {
      const binding = inputBindings.find(x => x.fixture_id === f.fixture_id).bindings, input = binding[0];
      try {
        const result = await session.observeAudio({ path: input.path, source_sha256: input.actual_sha256,
          segment_id: f.fixture_id, asset_id: f.fixture_id, source_range: [0, input.duration_seconds] },
          path.join(out, 'observations', f.fixture_id), { purpose: 'qualification',
            context: f.untrusted_caption ? { untrusted_caption: f.untrusted_caption } : null });
        if (await hashFile(result.api_evidence.path) !== result.api_evidence.sha256) throw new Error('api_audit_hash_mismatch');
        const audit = await readJson(result.api_evidence.path);
        if (await hashFile(result.input_audio.path) !== result.input_audio.sha256
          || audit.audio_sha256 !== result.input_audio.sha256
          || audit.submitted_pcm_sha256 !== result.pcm_sha256
          || audit.source_sha256 !== input.actual_sha256
          || JSON.stringify(audit.source_window) !== JSON.stringify([0, input.duration_seconds])
          || !audioBackendMatches(audit, backend)
          || await hashFile(audit.raw_response.path) !== audit.raw_response.sha256)
          throw new Error('api_submitted_input_or_response_binding_mismatch');
        if (await hashFile(input.path) !== input.actual_sha256) throw new Error('qualification_input_changed');
        results.push({ ...result, fixture_id: f.fixture_id, input_bindings: binding, audit_binding_verified: true });
      } catch { errors.push({ fixture_id: f.fixture_id, code: 'qualification_api_execution_failed' }); break; }
    }
    if (!errors.length) for (const item of preparedPairs) {
      try {
        for (const b of item.bindings) if (await hashFile(b.path) !== b.actual_sha256) throw new Error('pair_input_changed');
        const response = await session.post('gemini', item.payload, 'qualification_pair', backend);
        const audit = await saveJson(path.join(out, 'observations', item.pair.pair_id, 'api-evidence.json'),
          { schema_version: 1, ...response, input_bindings: item.bindings, window_binding: item.pair.window_binding,
            actual_modalities: ['video_with_combined_audio'], cache_hit: false });
        for (const b of item.bindings) if (await hashFile(b.path) !== b.actual_sha256) throw new Error('pair_input_changed');
        const record = { ...response, fixture_id: null, pair_id: item.pair.pair_id, observation: response.value,
          model: response.model, actual_audio_processed: true, completion_status: 'complete',
          input_bindings: item.bindings, actual_modalities: ['video_with_combined_audio'],
          window_binding: item.pair.window_binding, api_evidence: audit, audit_binding_verified: true,
          artistic_approval: false };
        record.file = await saveJson(path.join(out, 'observations', item.pair.pair_id, 'observation.json'), record);
        results.push(record);
      } catch { errors.push({ pair_id: item.pair.pair_id, code: 'qualification_api_execution_failed' }); break; }
    }
  }
  if (await hashFile(manifestFile) !== snapshot.sha256) throw new Error('qualification_manifest_changed');
  await verifyEvidenceBindings(inputBindings);
  const evaluation = results.length ? evaluateQualification(results, fixtures, pairs, backend) : report;
  const passedRequested = evaluation.scopes.includes(requested) && !errors.length && !missing.length;
  const final = { ...evaluation, status: errors.some(error => error.fixture_id) ? 'qualification_failed'
    : passedRequested ? 'qualified' : evaluation.status, qualified: passedRequested,
    fixture_manifest: snapshot, evidence: preparation, input_bindings: inputBindings,
    requested_scope: requested, requested_scope_passed: passedRequested,
    model_calls: session.ledger.length, cloud_uploads: session.ledger.length,
    missing, errors, results, artistic_approval: false, assessed_at: new Date().toISOString() };
  if (errors.some(error => error.fixture_id)) { final.scopes = []; final.qualified = false; }
  else if (errors.length) {
    final.scopes = final.scopes.filter(scope => scope !== 'music_candidate_judgment');
    final.qualified = final.scopes.includes('audio_observation');
  } else if (final.scopes.includes('audio_observation')) final.qualified = true;
  const file = await saveJson(path.join(out, 'qualification.json'), final);
  return { ...final, file };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runQualification(process.argv[2]).then(result => {
    process.stdout.write(JSON.stringify({ status: result.status, scopes: result.scopes,
      model_calls: result.model_calls, missing: result.missing, file: result.file }) + '\n');
  }).catch(() => { process.stderr.write('audio_qualification_failed\n'); process.exitCode = 1; });
}

