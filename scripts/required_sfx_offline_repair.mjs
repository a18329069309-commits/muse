import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyCompletedSfxCliSelection } from './completed_sfx_cli_evidence.mjs';

export const requiredSfxOfflineRepairRevision = 'required-sfx-pcm-continuity-repair-v1';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => canonical(a) === canonical(b);
const noApproval = () => ({ sound_facts_qualified: false, usage_approved: false,
  artistic_approval: false, production_approval: false, qualification_granted: false });
const one = (rows, test, label) => {
  const found = (rows ?? []).filter(test);
  if (found.length !== 1) throw Error(`required_sfx_repair_${label}_not_unique`);
  return found[0];
};
const clockRange = range => {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] < 0 || range[1] <= range[0])
    throw Error('required_sfx_repair_range_invalid');
  const samples = range.map(value => Math.round(value * 48000));
  if (samples.some((value, i) => !Number.isSafeInteger(value) || Math.abs(range[i] * 48000 - value) > 1e-5))
    throw Error('required_sfx_repair_sample_clock_invalid');
  return samples;
};
async function boundBytes(binding) {
  if (!binding?.path || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? '')) throw Error('required_sfx_repair_binding_required');
  const bytes = await readFile(binding.path);
  if (bytesHash(bytes) !== binding.sha256) throw Error('required_sfx_repair_binding_changed');
  return bytes;
}
const readBound = async binding => JSON.parse((await boundBytes(binding)).toString('utf8').replace(/^\uFEFF/, ''));
export const bindRequiredSfxRepairFile = async file => ({ path: path.resolve(file), sha256: bytesHash(await readFile(file)) });
async function immutableJson(file, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await mkdir(path.dirname(file), { recursive: true });
  try { await writeFile(file, bytes, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!bytes.equals(await readFile(file))) throw Error('required_sfx_repair_existing_output_changed');
  }
  return { path: path.resolve(file), sha256: bytesHash(bytes) };
}
const bindingKeys = ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates',
  'current_materials', 'case_routes', 'music_source_provenance'];

// A retired application executable cannot requalify its historical selector.
// This narrower branch only recovers immutable candidates for PCM measurement;
// it grants no reusable selection, and never creates model submission tasks.
async function historicalMissingCliTechnicalProvenance(record, request, raw) {
  const parts = raw.constituent_responses?.length ? raw.constituent_responses : [record.raw_response];
  const receipts = [];
  for (const binding of parts) {
    const part = await readBound(binding);
    if (part.actual_runtime_executed !== true || part.completion_status !== 'complete'
        || part.input_sha256 !== record.input.sha256 || part.source_video_sha256 !== request.source_video_sha256
        || part.cli_receipts?.length !== 1 || part.partition_revision || (part.historical_cli_receipts ?? []).length)
      throw Error('required_sfx_repair_historical_cli_provenance_invalid');
    const requestRef = part.evidence_files?.find(ref => path.resolve(ref.path)
      === path.join(path.dirname(path.resolve(binding.path)), 'request.json'));
    const actualRequest = await readBound(requestRef), receiptRef = part.cli_receipts[0], receipt = await readBound(receiptRef);
    if (actualRequest.role !== 'material_candidate_selection' || actualRequest.execution_kind !== 'codex_cli_inference'
        || actualRequest.input_sha256 !== record.input.sha256 || actualRequest.source_video_sha256 !== request.source_video_sha256
        || digest(actualRequest) !== part.request_sha256 || !same(receipt.request, requestRef)
        || receipt.request_sha256 !== part.request_sha256 || receipt.input_sha256 !== record.input.sha256
        || receipt.source_video_sha256 !== request.source_video_sha256 || receipt.status !== 'complete'
        || receipt.execution_kind !== 'codex_cli_inference' || receipt.cli_invocations !== 1
        || receipt.process_terminated !== true || receipt.timed_out !== false
        || receipt.synthetic_protocol_fixture || receipt.actual_test_inference_performed === false
        || receipt.new_api_key_used !== false || receipt.production_approval !== false
        || receipt.worker_profile !== actualRequest.worker_profile
        || receipt.worker_instructions?.sha256 !== actualRequest.worker_instructions?.sha256
        || !same(receipt.transport, actualRequest.transport) || !same(part.transport, actualRequest.transport))
      throw Error('required_sfx_repair_historical_cli_provenance_invalid');
    for (const ref of [...(part.evidence_files ?? []), ...(actualRequest.input_bindings ?? []),
      receipt.final, receipt.schema, receipt.prompt, receipt.jsonl, receipt.host_business_contract,
      receipt.host_cli_resolution, receipt.worker_instructions]) await boundBytes(ref);
    const resolution = await readBound(receipt.host_cli_resolution);
    if (resolution.resolution_kind !== 'missing_configured_path_to_verified_codex_application_bin'
        || resolution.injected === true || resolution.fallback_used !== true
        || resolution.logical_configuration_unchanged !== true || receipt.command !== resolution.actual_path
        || !path.isAbsolute(resolution.actual_path ?? '')
        || !/[\\/]OpenAI[\\/]Codex[\\/]bin[\\/][a-f0-9]{16,64}[\\/]codex\.exe$/i.test(resolution.actual_path)
        || !/^[a-f0-9]{64}$/.test(resolution.actual_executable_sha256 ?? ''))
      throw Error('required_sfx_repair_historical_cli_provenance_invalid');
    try { await stat(resolution.actual_path); throw Error('required_sfx_repair_historical_cli_not_missing'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    receipts.push({receipt: receiptRef, cli_resolution: receipt.host_cli_resolution,
      historical_executable_sha256: resolution.actual_executable_sha256,
      historical_executable_path: resolution.actual_path, status: 'historical_cli_unavailable'});
  }
  if (!same(raw.cli_receipts, receipts.map(row => row.receipt)))
    throw Error('required_sfx_repair_historical_cli_provenance_invalid');
  return {status: 'historical_cli_unavailable', selection_qualification: 'unverified',
    technical_candidate_measurement_only: true, original_selector_request: record.input,
    original_selector_response: record.raw_response, receipts, ...noApproval()};
}

// Preparation deliberately reads old evidence. It never changes the omitted
// event, selected asset, source window, old model response, or episode ledger.
export async function prepareRequiredSfxOfflineRepair(spec) {
  const assemblyPreflight = spec.gap_origin === 'assembly_material_preflight';
  if (spec.gap_origin !== undefined && !assemblyPreflight) throw Error('required_sfx_repair_gap_origin_unsupported');
  const [queue, caller, tasksDocument, selectorRecord, publication, budget] = await Promise.all([
    readBound(assemblyPreflight ? spec.material_preflight : spec.gap_queue), readBound(spec.assembly_input), readBound(spec.sound_tasks),
    readBound(spec.selection_record), readBound(spec.sound_publication), readBound(spec.budget),
  ]);
  const input = caller.data;
  const source = assemblyPreflight ? input?.source : queue.source;
  const originalPreflight = spec.original_material_preflight ?? spec.material_preflight;
  if (assemblyPreflight && (caller.kind !== 'assembly_material_preflight_offline_input'
      || !same(caller.material_preflight, originalPreflight)
      || queue.revision !== 'object-scoped-gap-v1' || queue.status !== 'assembly_material_execution_gap'
      || queue.source_video_sha256 !== source?.sha256 || queue.production_approval !== false
      || queue.qualification_granted !== false || queue.new_model_calls !== 0
      || !Array.isArray(queue.execution_blockers))) throw Error('required_sfx_repair_assembly_preflight_scope_required');
  if (assemblyPreflight) {
    const assembly = await readBound(caller.assembly_result);
    if (assembly.status !== 'research_assembly_execution_gap'
        || !same(assembly.stage?.material_preflight, originalPreflight)
        || !same(assembly.inputs, input?.bound_artifacts))
      throw Error('required_sfx_repair_bound_assembly_result_required');
    if (originalPreflight.sha256 !== spec.material_preflight.sha256)
      throw Error('required_sfx_repair_assembly_preflight_binding_required');
  }
  if (!source?.path || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') || input?.source_video_sha256 !== source.sha256 ||
      input.source?.sha256 !== source.sha256 || budget.identity?.source_video_sha256 !== source.sha256 ||
      path.resolve(budget.identity?.output_root ?? '') !== path.resolve(spec.job_root ?? ''))
    throw Error('required_sfx_repair_source_or_job_changed');
  if (spec.budget_state_path !== undefined && path.resolve(spec.budget_state_path)
      !== path.resolve(spec.job_root,'independent-trial-budget','state.json'))
    throw Error('required_sfx_repair_live_budget_path_changed');
  await boundBytes(source);
  if (!same(Object.keys(input.bound_artifacts ?? {}).sort(), [...bindingKeys].sort()))
    throw Error('required_sfx_repair_full_caller_bindings_required');
  const documents = Object.fromEntries(await Promise.all(bindingKeys.map(async key =>
    [key, await readBound(input.bound_artifacts[key])])));
  for (const key of ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates', 'current_materials', 'case_routes', 'music_source_provenance']) {
    if (!same(input[key], documents[key])) throw Error('required_sfx_repair_full_caller_facts_changed');
  }
  if (assemblyPreflight && (documents.manifest.source_sha256 !== source.sha256
      || documents.analysis.source_video_sha256 !== source.sha256
      || documents.director.source_video_sha256 !== source.sha256))
    throw Error('required_sfx_repair_source_or_job_changed');
  const request = await readBound(selectorRecord.input);
  const raw = await readBound(selectorRecord.raw_response);
  if (request.source_video_sha256 !== source.sha256 || raw.source_video_sha256 !== source.sha256 ||
      raw.input_sha256 !== selectorRecord.input.sha256 || !raw.actual_runtime_executed || raw.completion_status !== 'complete' ||
      request.sfx_event_function_revision !== 'sound-event-function-v2' ||
      request.sfx_diagnostic_selection_policy?.qualification_granted !== false ||
      request.sfx_diagnostic_selection_policy?.production_approval !== false)
    throw Error('required_sfx_repair_actual_selector_required');
  let selectorProvenance = null;
  try { await verifyCompletedSfxCliSelection(selectorRecord); }
  catch (error) {
    if (!assemblyPreflight || error.message !== 'completed_sfx_cli_actual_cli_profile_changed') throw error;
    selectorProvenance = await historicalMissingCliTechnicalProvenance(selectorRecord, request, raw);
  }
  await boundBytes(request.candidate_source);
  await boundBytes(request.case_source);
  const assets = (await readBound(publication.assets)).assets;
  const segments = (await readBound(publication.segments)).segments;
  await boundBytes(publication.library);
  if (!Array.isArray(assets) || !Array.isArray(segments)) throw Error('required_sfx_repair_published_assets_required');
  const required = assemblyPreflight ? queue.execution_blockers.filter(row => row.kind === 'execution_blocker'
    && row.object_kind === 'event' && ['required_sound_material_missing', 'required_sound_window_insufficient'].includes(row.reason_code))
    : queue.gaps.filter(row => row.stage === 'post_render_sound_coverage' && row.status !== 'resolved' && row.required === true);
  if (!required.length) return { revision: requiredSfxOfflineRepairRevision, status: 'no_required_sound_repair', tasks: [] };
  if (new Set(required.map(row => assemblyPreflight ? row.object_id : row.event_id)).size !== required.length) throw Error('required_sfx_repair_event_duplicate');
  const technicalTasks = [], eventTasks = [];
  for (const gap of required) {
    const eventId = assemblyPreflight ? gap.object_id : gap.event_id;
    if (!assemblyPreflight) {
      if (gap.source_video_sha256 !== source.sha256 || gap.reason !== 'required_sound_event_has_no_actual_adoption')
        throw Error('required_sfx_repair_gap_scope_unsupported');
      const [coverage, rendered] = await Promise.all([readBound(gap.sound_coverage), readBound(gap.rendered_result)]);
      const coverageRow = one(coverage.sound_task_gaps, row => row.event_id === eventId, 'coverage_event');
      if (coverageRow.required !== true || coverageRow.gap !== gap.reason || coverageRow.decision !== gap.adoption_decision ||
          coverageRow.reason !== gap.editor_reason || rendered.source_video_sha256 !== source.sha256 ||
          !same(rendered.render?.outputs?.['sound-coverage.json'], gap.sound_coverage))
        throw Error('required_sfx_repair_original_required_or_coverage_changed');
    }
    const event = one(documents.analysis.sound_events, row => row.id === eventId, 'analysis_event');
    const task = one(tasksDocument.tasks, row => row.source_event_id === eventId, 'sound_task');
    const query = one(documents.director.sound_queries, row => row.event_id === eventId, 'director_query');
    const selectedTask = one(request.tasks, row => row.reference_event?.event_id === eventId, 'selector_task');
    const decision = one(raw.value?.decisions, row => row.case_id === selectedTask.case_id && row.step_id === selectedTask.step_id, 'selector_decision');
    const targetRange = [event.start_seconds, event.end_seconds], targetSamples = clockRange(targetRange);
    const intent = task.sound_function_intent;
    if (event.decision !== 'seek_asset' || !['dramatic', 'transition'].includes(event.role) || task.sound_role !== event.role ||
        intent?.event_role !== event.role || intent.event_id !== event.id || intent.revision !== 'sound-event-function-v2' ||
        !same(intent.target_range, targetRange) || intent.required_duration_samples !== targetSamples[1] - targetSamples[0] ||
        !same(selectedTask.sound_function_intent, intent) || !same(selectedTask.reference_event.source_range, targetRange) ||
        query.text !== intent.original_intent || selectedTask.sound_role !== event.role ||
        decision.sound_role !== event.role || decision.selected_segment_ids.length !== 0 || decision.sound_usage !== null ||
        (gap.target_range !== null && gap.target_range !== undefined && !same(gap.target_range, targetRange)))
      throw Error('required_sfx_repair_event_intent_or_clock_changed');
    for (const evidence of task.evidence_files ?? []) await boundBytes(evidence);
    const candidates = [];
    for (const candidate of selectedTask.candidates) {
      const asset = one(assets, row => row.asset_id === candidate.asset_id, 'asset');
      const segment = one(segments, row => row.segment_id === candidate.segment_id, 'segment');
      const window = clockRange(candidate.source_range);
      if (candidate.source_sha256 !== asset.sha256 || candidate.source_sha256 !== segment.source_sha256 ||
          segment.asset_id !== asset.asset_id || !same(segment.source_range, candidate.source_range) ||
          !same(candidate.observation?.window_source_range, candidate.source_range) || asset.actual_clock?.sample_rate_hz !== 48000 ||
          asset.actual_clock.samples !== candidate.observation?.actual_clock?.samples || window[1] > asset.actual_clock.samples ||
          asset.production_approval !== false || segment.production_approval !== false || candidate.observation?.usage_approved !== false)
        throw Error('required_sfx_repair_candidate_window_or_clock_changed');
      const receiptBinding = asset.pcm_proxy?.receipt;
      const receipt = await readBound(receiptBinding);
      if (receipt.kind !== 'local_sound_actual_pcm_decode' || receipt.pcm_sha256 !== candidate.source_sha256 ||
          receipt.original_sha256 !== asset.original_source?.sha256 || receipt.decoded_samples !== asset.actual_clock.samples ||
          receipt.sample_rate_hz !== 48000 || receipt.channels !== 2 || receipt.full_decode?.exit_code !== 0 ||
          receipt.full_decode?.strict_errors !== true || receipt.sound_facts_qualified !== false ||
          path.resolve(receipt.pcm_path) !== path.resolve(asset.path))
        throw Error('required_sfx_repair_existing_decode_proof_changed');
      const reject = one(decision.rejections, row => row.segment_id === candidate.segment_id, 'rejection');
      const identity = { segment_id: candidate.segment_id, asset_id: candidate.asset_id,
        source_pcm: { path: asset.path, sha256: candidate.source_sha256 },
        source_range: candidate.source_range, source_range_samples: window, actual_source_samples: asset.actual_clock.samples,
        sample_rate_hz: 48000, decode_receipt: receiptBinding, original_source: asset.original_source,
        original_observation_sha256: digest(candidate.observation),
        observation_request: selectorRecord.input, observation_json_pointer: `/tasks/${request.tasks.indexOf(selectedTask)}/candidates/${selectedTask.candidates.indexOf(candidate)}/observation`,
      };
      const technicalId = digest({ source: identity.source_pcm, window, required_samples: intent.required_duration_samples });
      if (!technicalTasks.some(row => row.task_id === technicalId)) technicalTasks.push({
        task_id: technicalId, kind: 'offline_exact_pcm_local_continuity_and_edit_margin',
        ...identity, required_duration_samples: intent.required_duration_samples, ...noApproval(),
      });
      candidates.push({ ...identity, offline_task_id: technicalId, previous_rejection: reject.reason });
    }
    eventTasks.push({ event_id: eventId, gap_id: assemblyPreflight ? digest({ preflight: spec.material_preflight, gap }) : gap.gap_id, role: event.role, required: true,
      target_range: targetRange, target_range_samples: targetSamples, required_duration_samples: intent.required_duration_samples,
      sound_function_intent: intent, original_director_query: query, previous_adopt_reason: decision.adopt_reason,
      previous_unresolved_gaps: decision.unresolved_gaps,
      ...(assemblyPreflight ? { gap_origin: 'assembly_material_preflight', material_preflight: spec.material_preflight,
        original_gap: gap } : { previous_editor_reason: gap.editor_reason, sound_coverage: gap.sound_coverage, rendered_result: gap.rendered_result }),
      candidates,
      ...noApproval() });
  }
  const sources = new Set(technicalTasks.map(row => row.source_pcm.sha256));
  const sourceLimit = spec.max_pcm_sources ?? 16;
  if (!Number.isInteger(sourceLimit) || sourceLimit < 1 || sourceLimit > 32 || sources.size > sourceLimit)
    throw Error('required_sfx_repair_offline_subbatch_limit_exceeded');
  const identity = { revision: requiredSfxOfflineRepairRevision, spec, source, bound_artifacts: input.bound_artifacts,
    selector_request: selectorRecord.input, selector_raw_response: selectorRecord.raw_response,
    ...(selectorProvenance ? {selector_provenance: selectorProvenance} : {}),
    processor: await bindRequiredSfxRepairFile(fileURLToPath(import.meta.url)),
    event_tasks: eventTasks, tasks: technicalTasks, ...noApproval() };
  return { ...identity, request_sha256: digest(identity), status: 'offline_tasks_ready',
    distinct_pcm_sources: sources.size, model_calls_allowed_in_offline_consumer: 0 };
}

export async function persistRequiredSfxOfflineRepair(spec, outputDirectory) {
  // These two live documents advance legitimately. Preserve their exact
  // initial bytes as historical inputs rather than later reading a stale SHA
  // from the live path or resetting its ledger to make it match.
  const snapshots = {};
  const originKey = spec.gap_origin === 'assembly_material_preflight' ? 'material_preflight' : 'gap_queue';
  for (const key of [originKey, 'budget']) {
    const bytes = await boundBytes(spec[key]);
    const file = path.join(outputDirectory, 'input-snapshots', `${key}-${spec[key].sha256}.json`);
    await mkdir(path.dirname(file), { recursive: true });
    try { await writeFile(file, bytes, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error;
      if (!bytes.equals(await readFile(file))) throw Error('required_sfx_repair_existing_snapshot_changed'); }
    snapshots[key] = { path: path.resolve(file), sha256: spec[key].sha256 };
  }
  const prepared = await prepareRequiredSfxOfflineRepair({ ...spec, ...snapshots,
    ...(originKey === 'material_preflight'
      ? { original_material_preflight: spec.original_material_preflight ?? spec.material_preflight }
      : { original_gap_queue: spec.original_gap_queue ?? spec.gap_queue }),
    budget_state_path: spec.budget_state_path ?? spec.budget.path });
  if (!prepared.request_sha256) return prepared;
  const directory = path.join(outputDirectory, prepared.request_sha256);
  return { status: prepared.status, directory, request: await immutableJson(path.join(directory, 'request.json'), prepared),
    task_ids: prepared.tasks.map(row => row.task_id), event_ids: prepared.event_tasks.map(row => row.event_id), ...noApproval() };
}

// Only RIFF integer PCM is accepted. No decoder, resampling, padding, or model
// is hidden in this consumer; old proxy bytes and exact sample clocks stay fixed.
export function readRepairPcmWave(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' ||
      bytes.readUInt32LE(4) + 8 > bytes.length) throw Error('required_sfx_repair_pcm_riff_required');
  let format = null, data = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw Error('required_sfx_repair_pcm_chunk_truncated');
    if (kind === 'fmt ') {
      if (format || size < 16) throw Error('required_sfx_repair_pcm_format_invalid');
      format = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
        sample_rate_hz: bytes.readUInt32LE(start + 4), block_align: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
    }
    if (kind === 'data') { if (data) throw Error('required_sfx_repair_pcm_data_duplicate'); data = { offset: start, bytes: size }; }
    offset = start + size + (size % 2);
  }
  if (!format || !data || format.encoding !== 1 || format.channels !== 2 || format.sample_rate_hz !== 48000 ||
      ![16, 24, 32].includes(format.bits) || format.block_align !== format.channels * format.bits / 8 || data.bytes % format.block_align)
    throw Error('required_sfx_repair_exact_integer_pcm_clock_required');
  return { ...format, ...data, samples: data.bytes / format.block_align };
}
const db = amplitude => amplitude > 0 ? 20 * Math.log10(amplitude) : null;
const quantile = (sorted, q) => sorted[Math.floor((sorted.length - 1) * q)];
function continuitySummary(bins, frameSamples, sourceSamples) {
  const sorted = bins.map(row => row.rms).sort((a, b) => a - b), q50 = quantile(sorted, .5);
  const thresholds = [-60, -70].map(value => ({ basis: 'fixed_dbfs', dbfs: value, amplitude: 10 ** (value / 20) }));
  thresholds.push({ basis: 'local_q50_minus_12db', dbfs: db(q50) === null ? null : db(q50) - 12, amplitude: q50 * 10 ** (-12 / 20) });
  return { bin_samples: frameSamples, samples: sourceSamples,
    rms_dbfs_quantiles: { q10: db(quantile(sorted, .1)), q50: db(q50), q90: db(quantile(sorted, .9)) },
    thresholds: thresholds.map(threshold => {
      let active = 0, run = 0, longest = 0;
      for (const row of bins) {
        if (row.rms > threshold.amplitude) { active += row.samples; run = 0; }
        else { run += row.samples; longest = Math.max(longest, run); }
      }
      return { ...threshold, active_samples: active, active_fraction: active / sourceSamples, longest_quiet_gap_samples: longest };
    }) };
}
export function measureRequiredSfxPcm(bytes, task) {
  const wave = readRepairPcmWave(bytes);
  if (wave.samples !== task.actual_source_samples || wave.sample_rate_hz !== task.sample_rate_hz || bytesHash(bytes) !== task.source_pcm.sha256)
    throw Error('required_sfx_repair_actual_pcm_changed');
  const [start, end] = task.source_range_samples;
  if (!same(clockRange(task.source_range), [start, end]) || end > wave.samples || start >= end)
    throw Error('required_sfx_repair_measured_window_changed');
  const bytesPerChannel = wave.bits / 8, denominator = 2 ** (wave.bits - 1), step = wave.block_align;
  const sampleValue = offset => wave.bits === 16 ? bytes.readInt16LE(offset)
    : wave.bits === 24 ? bytes.readIntLE(offset, 3) : bytes.readInt32LE(offset);
  const framePower = new Float64Array(end - start);
  let peak = 0, clips = 0;
  for (let frame = start; frame < end; frame++) {
    let sum = 0;
    for (let channel = 0; channel < 2; channel++) {
      const raw = sampleValue(wave.offset + frame * step + channel * bytesPerChannel), value = raw / denominator;
      sum += value * value; peak = Math.max(peak, Math.abs(value));
      if (raw === -denominator || raw === denominator - 1) clips++;
    }
    framePower[frame - start] = sum / 2;
  }
  const binsFor = (lo, hi, stepSamples) => {
    const bins = [];
    for (let position = lo; position < hi; position += stepSamples) {
      const stop = Math.min(hi, position + stepSamples); let power = 0;
      for (let index = position; index < stop; index++) power += framePower[index];
      bins.push({ start_sample: start + position, samples: stop - position, rms: Math.sqrt(power / (stop - position)) });
    }
    return bins;
  };
  const total = end - start, required = task.required_duration_samples;
  if (!Number.isSafeInteger(required) || required <= 0) throw Error('required_sfx_repair_required_duration_invalid');
  const positions = total >= required ? [...new Set([0, Math.floor((total - required) / 2), total - required])] : [];
  const windows = positions.map(position => ({ source_range_samples: [start + position, start + position + required],
    source_range: [(start + position) / 48000, (start + position + required) / 48000],
    left_available_handle_samples: position, right_available_handle_samples: total - position - required,
    continuity_10ms: continuitySummary(binsFor(position, position + required, 480), 480, required),
    continuity_100ms: continuitySummary(binsFor(position, position + required, 4800), 4800, required),
    placement_basis: 'deterministic_head_middle_tail_measurement_grid_not_asset_selection', function_fit: 'unknown' }));
  const bins = binsFor(0, total, 480);
  return { kind: 'exact_pcm_local_continuity_and_edit_margin', task_id: task.task_id,
    source_pcm: task.source_pcm, segment_id: task.segment_id, asset_id: task.asset_id,
    source_range: task.source_range, source_range_samples: [start, end], source_window_sha256: digest({
      source_sha256: task.source_pcm.sha256, source_range_samples: [start, end], sample_rate_hz: 48000 }),
    actual_clock: { sample_rate_hz: 48000, channels: 2, bits: wave.bits, source_samples: wave.samples, measured_samples: total },
    requested_duration_samples: required, available_minus_required_samples: total - required,
    feasible_source_start_interval_samples: total >= required ? [start, end - required] : null,
    technical_duration_gap: total < required ? 'candidate_pcm_window_short_for_required_span' : null,
    peak_dbfs: db(peak), clipped_channel_samples: clips,
    continuity_10ms: continuitySummary(bins, 480, total), continuity_100ms: continuitySummary(binsFor(0, total, 4800), 4800, total),
    energy_bins_10ms: bins, exact_length_local_windows: windows,
    sound_identity: 'unknown', cleanliness: 'unknown', speech_presence: 'unknown', music_presence: 'unknown', function_fit: 'unknown',
    measured_transients_are_verified_auditory_anchors: false, source_decoded_again: false, actual_audio_listened: false,
    ...noApproval() };
}

export function inspectRequiredSfxRepairBudget(budget, request, plannedModelCalls = 2) {
  if (budget.identity?.source_video_sha256 !== request.source.sha256 ||
      path.resolve(budget.identity?.output_root ?? '') !== path.resolve(request.spec.job_root) ||
      !Number.isSafeInteger(plannedModelCalls) || plannedModelCalls < 2)
    throw Error('required_sfx_repair_budget_identity_changed');
  const limits = budget.identity.limits;
  if (!limits || Object.entries({max_requests:12,max_input_tokens:16000,max_elapsed_ms:1200000})
    .some(([key, maximum]) => !Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum))
    throw Error('required_sfx_repair_budget_limits_invalid');
  const charged = budget.requests.reduce((sum, row) => {
    const count = row.confirmed_invocations ?? 1;
    if (!Number.isSafeInteger(count) || count < 0) throw Error('required_sfx_repair_budget_charge_invalid');
    return sum + count;
  }, 0);
  const elapsed = (budget.run_history ?? []).reduce((sum, row) => {
    if (!Number.isSafeInteger(row.started_at_ms) || row.started_at_ms < 0 ||
        (row.finished_at_ms !== undefined && (!Number.isSafeInteger(row.finished_at_ms) || row.finished_at_ms < row.started_at_ms)))
      throw Error('required_sfx_repair_budget_elapsed_invalid');
    return sum + (row.finished_at_ms ?? row.started_at_ms) - row.started_at_ms;
  }, 0);
  const remaining = limits.max_requests - charged;
  return { charged_requests: charged, remaining_requests: remaining, active_elapsed_ms: elapsed,
    max_requests: limits.max_requests, max_elapsed_ms: limits.max_elapsed_ms, max_input_tokens: limits.max_input_tokens,
    planned_minimum_new_requests: plannedModelCalls, original_budget_preserved: true,
    status: budget.active_run ? 'waiting_active_job' : remaining < plannedModelCalls ? 'waiting_budget'
      : elapsed >= limits.max_elapsed_ms ? 'waiting_elapsed_budget' : 'waiting_full_envelope_preflight' };
}

export async function executeRequiredSfxOfflineRepair(requestBinding, outputDirectory) {
  const request = await readBound(requestBinding), rebuilt = await prepareRequiredSfxOfflineRepair(request.spec);
  if (!same(request, rebuilt)) throw Error('required_sfx_repair_request_reconstruction_changed');
  const outputs = [], cache = new Map();
  for (const task of request.tasks) {
    if (!cache.has(task.source_pcm.sha256)) cache.set(task.source_pcm.sha256, await boundBytes(task.source_pcm));
    const evidence = measureRequiredSfxPcm(cache.get(task.source_pcm.sha256), task);
    outputs.push({ task_id: task.task_id, evidence: await immutableJson(path.join(outputDirectory, `pcm-${task.task_id}.json`), evidence) });
  }
  const localInput = await readBound(request.selector_request);
  localInput.tasks = localInput.tasks.filter(task => request.event_tasks.some(event => event.event_id === task.reference_event?.event_id));
  for (const task of localInput.tasks) {
    const event = request.event_tasks.find(row => row.event_id === task.reference_event.event_id);
    for (const candidate of task.candidates) {
      const original = one(event.candidates, row => row.segment_id === candidate.segment_id, 'repair_input_candidate');
      const reference = one(outputs, row => row.task_id === original.offline_task_id, 'repair_input_evidence').evidence;
      const measured = await readBound(reference);
      // Keep every original probability/unknown/publisher hint. New numbers
      // complement the original observation; they cannot overwrite it.
      candidate.observation.local_pcm_continuity_repair = {
        revision: requiredSfxOfflineRepairRevision, evidence: reference,
        source_window_sha256: measured.source_window_sha256, actual_clock: measured.actual_clock,
        requested_duration_samples: measured.requested_duration_samples,
        available_minus_required_samples: measured.available_minus_required_samples,
        feasible_source_start_interval_samples: measured.feasible_source_start_interval_samples,
        technical_duration_gap: measured.technical_duration_gap, peak_dbfs: measured.peak_dbfs,
        clipped_channel_samples: measured.clipped_channel_samples, continuity_100ms: measured.continuity_100ms,
        exact_length_local_windows: measured.exact_length_local_windows.map(row => ({...row,continuity_10ms:undefined})),
        function_fit: 'unknown', cleanliness: 'unknown', actual_audio_listened: false, ...noApproval() };
    }
  }
  localInput.observation_files = [...(localInput.observation_files ?? []), ...outputs.map(row => row.evidence)];
  localInput.required_sfx_offline_repair = { revision: requiredSfxOfflineRepairRevision, request: requestBinding,
    original_selector_request: request.selector_request, event_ids: request.event_tasks.map(row => row.event_id),
    preserves_original_story_and_prior_rejections: true, new_audio_observation_is_technical_only: true,
    ...(request.spec.gap_origin ? { gap_origin: request.spec.gap_origin } : {}), ...noApproval() };
  if (request.selector_provenance?.status === 'historical_cli_unavailable') {
    localInput.required_sfx_offline_repair.selector_provenance = request.selector_provenance;
    localInput.required_sfx_offline_repair.selection_consumable = false;
    const candidateEvidence = await immutableJson(path.join(outputDirectory, 'technical-candidate-evidence-input.json'), localInput);
    const budgetState = inspectRequiredSfxRepairBudget(await readBound(request.spec.budget), request);
    const continuation = await immutableJson(path.join(outputDirectory, 'continuation-requirements.json'), {
      revision: requiredSfxOfflineRepairRevision, request: requestBinding, source_video_sha256: request.source.sha256,
      job_root: request.spec.job_root, original_budget: request.spec.budget, budget: budgetState,
      event_ids: request.event_tasks.map(row => row.event_id), technical_candidate_evidence: candidateEvidence,
      selector_provenance: request.selector_provenance, selection_consumable: false, model_submission_allowed: false,
      requirements: ['current trusted CLI identity', 'same-job current budget', 'complete actual input envelope',
        'new actual candidate comparison and selection', 'unchanged source windows and required event clocks'],
      new_model_calls: 0, ...noApproval() });
    const result = { revision: requiredSfxOfflineRepairRevision, status: 'offline_technical_evidence_completed',
      gap_origin: request.spec.gap_origin, request: requestBinding, source_video_sha256: request.source.sha256,
      event_ids: request.event_tasks.map(row => row.event_id), evidence: outputs, distinct_pcm_sources: cache.size,
      measured_window_tasks: outputs.length, existing_decodes_reused: cache.size, new_decodes: 0, new_model_calls: 0,
      selector_provenance: request.selector_provenance, selection_consumable: false, model_dependencies: null,
      technical_candidate_evidence: candidateEvidence, continuation_requirements: continuation, budget: budgetState,
      required_sound_gap_resolved: false, ...noApproval() };
    return { ...result, result: await immutableJson(path.join(outputDirectory, 'result.json'), result) };
  }
  const selectionInput = await immutableJson(path.join(outputDirectory, 'local-selection-input.json'), localInput);
  const budget = await readBound(request.spec.budget), budgetState = inspectRequiredSfxRepairBudget(budget, request);
  const selectorTask = { task_id: digest({ request: requestBinding, stage: 'local_sound_selection' }), stage: 'local_sound_selection',
    status: budgetState.status, source_video_sha256: request.source.sha256, job_root: request.spec.job_root,
    event_ids: request.event_tasks.map(row => row.event_id), request: requestBinding, input: selectionInput, offline_evidence: outputs,
    original_selector_request: request.selector_request, original_selector_raw_response: request.selector_raw_response,
    preserve_prior_rejections_and_unknown_facts: true, repair_limit: 0,
    maximum_new_requests_requires_full_envelope_preflight: true, ...noApproval() };
  const editorTask = { task_id: digest({ request: requestBinding, stage: 'local_sound_edit' }), stage: 'local_sound_edit',
    status: 'waiting_bound_local_selection', depends_on_task_id: selectorTask.task_id,
    event_ids: selectorTask.event_ids, job_root: request.spec.job_root, source_video_sha256: request.source.sha256,
    bound_original_caller: request.spec.assembly_input, preserve_music_plan_actions_and_other_sound_events: true,
    request: requestBinding, repair_limit: 0, ...noApproval() };
  const dependencies = await immutableJson(path.join(outputDirectory, 'model-dependencies.json'), {
    revision: requiredSfxOfflineRepairRevision, request: requestBinding, offline_evidence: outputs,
    budget_snapshot: request.spec.budget, budget: budgetState, tasks: [selectorTask, editorTask],
    all_future_envelopes_and_total_request_slots_must_pass_before_submission: true,
    new_model_calls: 0, qualification_granted: false, production_approval: false });
  const result = { revision: requiredSfxOfflineRepairRevision, status: 'offline_evidence_completed', request: requestBinding,
    ...(request.spec.gap_origin ? { gap_origin: request.spec.gap_origin } : {}),
    source_video_sha256: request.source.sha256, event_ids: selectorTask.event_ids, evidence: outputs,
    distinct_pcm_sources: cache.size, measured_window_tasks: outputs.length, existing_decodes_reused: cache.size,
    new_decodes: 0, new_model_calls: 0, model_dependencies: dependencies, budget: budgetState,
    required_sound_gap_resolved: false, ...noApproval() };
  return { ...result, result: await immutableJson(path.join(outputDirectory, 'result.json'), result) };
}

// A later queue reader rechecks the current ledger. The initial budget snapshot
// is provenance, never permission to submit from old spare slots. Even when
// slots exist this reader leaves the model task at full-envelope preflight.
export async function readRequiredSfxRepairDependencies(binding) {
  const dependencies = await readBound(binding), request = await readBound(dependencies.request);
  if (request.selector_provenance?.status === 'historical_cli_unavailable')
    throw Error('required_sfx_repair_unverified_selector_no_model_dependencies');
  if (!same(request, await prepareRequiredSfxOfflineRepair(request.spec)))
    throw Error('required_sfx_repair_request_reconstruction_changed');
  for (const row of dependencies.offline_evidence) await boundBytes(row.evidence);
  const currentBudget = await bindRequiredSfxRepairFile(request.spec.budget_state_path);
  const budget = inspectRequiredSfxRepairBudget(await readBound(currentBudget), request);
  return { ...dependencies, current_budget: currentBudget, budget,
    tasks: dependencies.tasks.map(row => ({...row,status:row.stage === 'local_sound_selection' ? budget.status : 'waiting_bound_local_selection'})),
    model_submission_allowed: false, full_envelope_preflight_still_required: true, ...noApproval() };
}

// This is the bounded, existing-PCM consumer used by the automatic controller.
// Model dependencies are persisted, but submission needs a separate complete
// same-job preflight; an offline measurement is never an adoption decision.
export async function runAssemblyMaterialRequiredSfxOfflineRepair({state, materialPreflight, jobRoot,
  outputDirectory, soundPublication}) {
  const assemblyRow = state?.stages?.assembly, assembly = assemblyRow?.result;
  const materials = state?.stages?.materials?.result;
  if (!materials?.sound_materials || !assembly?.stage?.material_preflight || !soundPublication)
    return {status: 'required_sfx_offline_repair_input_missing', new_model_calls: 0, ...noApproval()};
  if (!assemblyRow.result_binding || !same(await readBound(assemblyRow.result_binding), assembly))
    throw Error('required_sfx_repair_bound_assembly_result_required');
  materialPreflight ??= assembly.stage.material_preflight;
  if (!same(materialPreflight, assembly.stage.material_preflight))
    throw Error('required_sfx_repair_assembly_preflight_binding_required');
  const preflight = await readBound(materialPreflight), source = state.source;
  if (assembly.status !== 'research_assembly_execution_gap'
      || preflight.source_video_sha256 !== source?.sha256 || assembly.production_approval !== false
      || !same(Object.keys(assembly.inputs ?? {}).sort(), [...bindingKeys].sort()))
    throw Error('required_sfx_repair_bound_assembly_result_required');
  const documents = Object.fromEntries(await Promise.all(bindingKeys.map(async key =>
    [key, await readBound(assembly.inputs[key])])));
  if (documents.manifest.source_sha256 !== source.sha256 || documents.analysis.source_video_sha256 !== source.sha256
      || documents.director.source_video_sha256 !== source.sha256)
    throw Error('required_sfx_repair_source_or_job_changed');
  // Current controller roots can exceed Windows MAX_PATH after the immutable
  // request hash and exact-PCM task name are appended. Refuse before any write;
  // the host may supply a short output root without changing source/job identity.
  if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw Error('required_sfx_repair_absolute_output_required');
  const longestOutputPath = path.join(path.resolve(outputDirectory), '0'.repeat(64), `pcm-${'0'.repeat(64)}.json`);
  if (longestOutputPath.length >= 260) return {status: 'required_sfx_offline_repair_short_output_required',
    source_video_sha256: source.sha256, job_root: path.resolve(jobRoot), output_root: path.resolve(outputDirectory),
    longest_output_path: longestOutputPath, new_model_calls: 0, required_sound_gap_resolved: false, ...noApproval()};
  const combined = await readBound(materials.sound_materials), selection = await readBound(combined.selection);
  if (!same(selection.input, await bindRequiredSfxRepairFile(selection.input.path)))
    throw Error('required_sfx_repair_selector_input_changed');
  const caller = {kind: 'assembly_material_preflight_offline_input', assembly_result: assemblyRow.result_binding,
    material_preflight: materialPreflight, data: {source_video_sha256: source.sha256, source,
      bound_artifacts: assembly.inputs, ...documents}, ...noApproval()};
  const assemblyInput = await immutableJson(path.join(outputDirectory, 'assembly-material-preflight-input.json'), caller);
  const spec = {gap_origin: 'assembly_material_preflight', material_preflight: materialPreflight,
    job_root: path.resolve(jobRoot), assembly_input: assemblyInput,
    sound_tasks: await bindRequiredSfxRepairFile(path.join(path.dirname(combined.selection.path), '..', 'tasks.json')),
    selection_record: combined.selection, sound_publication: soundPublication,
    budget: await bindRequiredSfxRepairFile(path.join(jobRoot, 'independent-trial-budget', 'state.json')),
    max_pcm_sources: 16};
  const prepared = await persistRequiredSfxOfflineRepair(spec, outputDirectory);
  if (!prepared.request) return prepared;
  return executeRequiredSfxOfflineRepair(prepared.request, prepared.directory);
}

export async function runPostRenderRequiredSfxOfflineRepair({ state, gapQueue, jobRoot, outputDirectory, soundPublication }) {
  const materials = state.stages.materials?.result, assembly = state.stages.assembly?.result;
  if (!materials?.sound_materials || !assembly?.stage?.request || !soundPublication)
    return { status: 'required_sfx_offline_repair_input_missing', new_model_calls: 0, ...noApproval() };
  const combined = await readBound(materials.sound_materials), thin = await readBound(assembly.stage.request);
  const selection = await readBound(combined.selection);
  const spec = { job_root: path.resolve(jobRoot), gap_queue: gapQueue,
    assembly_input: thin.data?.full_input ?? assembly.stage.request,
    sound_tasks: await bindRequiredSfxRepairFile(path.join(path.dirname(combined.selection.path), '..', 'tasks.json')),
    selection_record: combined.selection, sound_publication: soundPublication,
    budget: await bindRequiredSfxRepairFile(path.join(jobRoot, 'independent-trial-budget', 'state.json')),
    max_pcm_sources: 16 };
  if (!same(selection.input, await bindRequiredSfxRepairFile(selection.input.path))) throw Error('required_sfx_repair_selector_input_changed');
  const prepared = await persistRequiredSfxOfflineRepair(spec, outputDirectory);
  if (!prepared.request) return prepared;
  return executeRequiredSfxOfflineRepair(prepared.request, prepared.directory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [operation, input, output] = process.argv.slice(2);
  if (operation === 'prepare' && input && output) {
    console.log(JSON.stringify(await persistRequiredSfxOfflineRepair(JSON.parse(await readFile(input, 'utf8')), output)));
  } else if (operation === 'execute' && input && output) {
    console.log(JSON.stringify(await executeRequiredSfxOfflineRepair(await bindRequiredSfxRepairFile(input), output)));
  } else throw Error('usage: required_sfx_offline_repair.mjs prepare|execute input.json output-directory');
}
