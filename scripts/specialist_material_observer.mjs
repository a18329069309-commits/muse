// Map frozen ASR/event inference to candidate windows; never grant hearing qualification.
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, saveJson, verifyEvidenceBindings, verifyLocalAudioExecution } from './audio_api.mjs';
import { createSpecialistResearchObserver, bindSpecialistReceipt } from './specialist_research_runtime.mjs';
import { createSpecialistWindowExecutor } from './specialist_window_executor.mjs';
import { verifyObservationContexts, scopedHumanContextFacts } from './material_observation_context.mjs';

const identity = (sha, range) => JSON.stringify([sha, range]);

export async function createSpecialistMaterialObserver(options) {
  if (!options.execution) return createBoundMaterialObserver(options);
  const executor = await createSpecialistWindowExecutor(options.execution, options.executionRuntime);
  const revision = createHash('sha256').update(JSON.stringify([executor.revision,
    (options.receipts ?? []).map(row => row.sha256), (options.featureReceipts ?? []).map(row => row.sha256)])).digest('hex');
  const backend = { protocol: 'local_audio_model', backend_id: 'local_specialist_receipts', model_revision: revision };
  const frozen = options.receipts?.length ? await createBoundMaterialObserver(options, backend) : null;
  const consume = async (job, directory, execution) => {
    if (execution.actual_audio_processed !== true || execution.execution_kind !== 'local_subprocess')
      throw new Error('specialist_window_test_execution_not_audio_evidence');
    const observer = await createBoundMaterialObserver({ receipts: execution.receipts,
      requiredBackends: options.requiredBackends }, backend);
    const result = await observer.materialObserver(job, directory);
    result.files.push(execution.execution_record, ...execution.bindings,
      ...execution.processes.map(row => row.configuration));
    await verifyEvidenceBindings(result.files);
    return result;
  };
  return { materialObserver_backend_id: backend.backend_id, materialObserver_model_revision: revision,
    materialObserver_audio_backend: backend,
    materialObserverBatch: async (entries, batchOptions = {}) => {
      if (!Array.isArray(entries) || !entries.length || entries.length > 8)
        throw new Error('specialist_batch_requires_one_to_eight_windows');
      await executor.verifyCurrent(); await verifyEvidenceBindings(executor.bindings);
      const results = new Array(entries.length), missing = [];
      for (const [index, { job, directory }] of entries.entries()) {
        if (frozen) try {
          const value = await frozen.materialObserver(job, directory);
          value.files.push(...executor.bindings); results[index] = { status: 'fulfilled', value }; continue;
        } catch (reason) {
          if (reason.message !== 'specialist_material_window_not_observed') {
            results[index] = { status: 'rejected', reason }; continue;
          }
        }
        missing.push({ index, job, directory });
      }
      if (missing.length) {
        const executed = await executor.executeBatch(missing.map(row => row.job), batchOptions);
        for (const [slot, row] of missing.entries()) {
          const result = executed[slot];
          if (result.status === 'rejected') { results[row.index] = result; continue; }
          try { results[row.index] = { status: 'fulfilled', value: await consume(row.job, row.directory, result.value) }; }
          catch (reason) { results[row.index] = { status: 'rejected', reason }; }
        }
      }
      return results;
    }, materialObserver: async (job, directory) => {
      await executor.verifyCurrent();
      await verifyEvidenceBindings(executor.bindings);
      if (frozen) {
        try {
          const result = await frozen.materialObserver(job, directory);
          result.files.push(...executor.bindings);
          return result;
        }
        catch (error) { if (error.message !== 'specialist_material_window_not_observed') throw error; }
      }
      const execution = await executor.execute(job);
      return consume(job, directory, execution);
    } };
}

async function createBoundMaterialObserver({ receipts,
  requiredBackends = ['qwen3_asr', 'panns_sed'], featureReceipts = [] }, backendIdentity = null) {
  const observe = await createSpecialistResearchObserver({ receipts, requiredBackends });
  const inputs = new Map();
  for (const file of receipts) {
    await verifyEvidenceBindings([file]);
    const run = await readJson(file.path);
    for (const job of run.jobs ?? []) {
      if (job.status !== 'predicted') continue;
      const rawFile = { path: job.raw_receipt, sha256: job.raw_sha256 };
      await verifyEvidenceBindings([rawFile]);
      const raw = await readJson(rawFile.path);
      if (!raw.input_file || !raw.input_sha256 || !raw.model_input_pcm_sha256
        || !Number.isSafeInteger(raw.model_input_sample_rate_hz) || raw.model_input_sample_rate_hz <= 0)
        throw new Error('specialist_material_pcm_binding_required');
      const input = { path: path.resolve(raw.input_file), sha256: raw.input_sha256 };
      const key = identity(raw.source_sha256, raw.source_window_seconds), previous = inputs.get(key);
      if (previous && previous.input.sha256 !== input.sha256)
        throw new Error('specialist_material_backends_used_different_input');
      inputs.set(key, { input, pcm: [...(previous?.pcm ?? []), {
        backend_id: run.backend, model_input_pcm_sha256: raw.model_input_pcm_sha256,
        sample_rate_hz: raw.model_input_sample_rate_hz,
      }], executions: [...(previous?.executions ?? []), { backend_id: run.backend,
        ...(run.device!==undefined?{device:run.device}:{}),
        model_revision: run.model_revision, model_sha256: run.model_sha256,
        forward_count: raw.forward_calls, run: file, raw_result: rawFile }] });
    }
  }
  const features = new Map();
  for (const file of featureReceipts) {
    await verifyEvidenceBindings([file]);
    const run = await readJson(file.path);
    if (run.backend !== 'beat_this_librosa_cpu' || run.device !== 'cpu' || !run.model_revision
      || run.qualified !== false || !run.script_binding || !run.checkpoint_binding)
      throw new Error('specialist_material_feature_execution_required');
    await verifyEvidenceBindings([run.script_binding, run.checkpoint_binding]);
    for (const job of run.jobs ?? []) {
      if (job.status !== 'measured') continue;
      const rawFile = { path: job.raw_receipt, sha256: job.raw_sha256 };
      await verifyEvidenceBindings([rawFile]);
      const raw = await readJson(rawFile.path), key = identity(raw.source_sha256, raw.source_window_seconds);
      const row = inputs.get(key), duration = raw.source_window_seconds?.[1] - raw.source_window_seconds?.[0];
      if (!row || raw.input_sha256 !== row.input.sha256 || !raw.mono_float32_pcm_sha256
        || !Number.isSafeInteger(raw.sample_rate_hz) || raw.sample_rate_hz <= 0
        || !row.pcm.some(pcm => pcm.sample_rate_hz === raw.sample_rate_hz
          && pcm.model_input_pcm_sha256 === raw.mono_float32_pcm_sha256)
        || raw.actual_audio_processed !== true || raw.model_revision !== run.model_revision
        || raw.device !== 'cpu' || raw.qualified !== false || raw.artistic_approval !== false
        || !Number.isSafeInteger(raw.forward_calls) || raw.forward_calls <= 0
        || raw.forward_calls !== job.forward_calls || !Number.isFinite(duration) || duration <= 0
        || Math.abs(raw.duration_seconds - duration) > 1 / raw.sample_rate_hz + 1e-8)
        throw new Error('specialist_material_feature_input_mismatch');
      const value = raw.features;
      if (!value || value.artistic_approval !== false || value.lyrics_verified !== false
        || value.duration_seconds !== raw.duration_seconds || value.sample_rate_hz !== raw.sample_rate_hz
        || value.phrase_boundaries_verified !== false || value.named_sections_verified !== false
        || ['beats_relative_seconds', 'downbeats_relative_seconds', 'onset_relative_seconds'].some(name =>
          !Array.isArray(value[name]) || value[name].some(x => !Number.isFinite(x) || x < 0 || x >= duration)))
        throw new Error('specialist_material_feature_scope_or_bounds_invalid');
      if (features.has(key)) throw new Error('specialist_material_duplicate_feature_window');
      features.set(key, { value, files: [file, rawFile, run.script_binding, run.checkpoint_binding],
        execution: { backend_id: run.backend, model_revision: run.model_revision,
          device: 'cpu', actual_audio_processed: true, forward_count: raw.forward_calls,
          input_audio_sha256: raw.input_sha256, input_pcm_sha256: raw.mono_float32_pcm_sha256,
          run: file, raw_result: rawFile, qualified: false, artistic_approval: false } });
    }
  }
  const revision = backendIdentity?.model_revision ?? (featureReceipts.length ? createHash('sha256').update(JSON.stringify([
    observe.model_revision, featureReceipts.map(file => file.sha256)])).digest('hex') : observe.model_revision);
  const backend = { protocol: 'local_audio_model', backend_id: 'local_specialist_receipts',
    model_revision: revision };
  const observeWindow = async (job, directory) => {
      const row = inputs.get(identity(job.source_sha256, job.source_range));
      if (!row) throw new Error('specialist_material_window_not_observed');
      const feature = features.get(identity(job.source_sha256, job.source_range));
      if (featureReceipts.length && !feature) throw new Error('specialist_material_feature_window_not_observed');
      const source = { path: typeof job.source_file === 'string' ? job.source_file : job.source_file.path,
        sha256: job.source_sha256 };
      await verifyEvidenceBindings([source, row.input, ...(feature?.files ?? [])]);
      const result = await observe({ source_video_sha256: job.source_sha256,
        source_range: job.source_range, input_audio: row.input }, directory);
      if (result.actual_input_processed !== true || result.actual_video_processed !== false)
        throw new Error('specialist_material_actual_audio_required');
      const observation = { ...result.value, input_pcm_by_backend: row.pcm,
        ...(feature ? { auxiliary_acoustic_features: feature.value,
          auxiliary_acoustic_execution: feature.execution } : {}),
        scope: 'actual_recording_window', lyrics_verified: false,
        sound_semantics_verified: false, artistic_approval: false };
      const raw = await saveJson(path.join(directory, 'material-observation-raw.json'), { observation });
      const localEvidence = await saveJson(path.join(directory, 'material-local-evidence.json'), {
        schema_version: 1, ...backend, source_sha256: job.source_sha256, source_range: job.source_range,
        source_binding: source, input_audio: row.input, raw_result: raw,
        execution: { actual_audio_processed: true, model_revision: backend.model_revision,
          input_audio_sha256: row.input.sha256,
          forward_count: row.executions.reduce((sum, execution) => sum + execution.forward_count, 0),
          backends: row.executions,
          ...(feature ? { auxiliary_acoustic: feature.execution } : {}) },
        qualified: false, artistic_approval: false, production_approval: false });
      const record = { schema_version: 1, ...backend, source_sha256: job.source_sha256,
        source_range: job.source_range, input_audio: row.input, observation,
        completion_status: 'complete', actual_audio_processed: true, local_evidence: localEvidence,
        qualified: false, artistic_approval: false, production_approval: false };
      await verifyLocalAudioExecution(record, backend);
      const observationRecord = await saveJson(path.join(directory, 'material-observation-record.json'), record);
      const files = [...new Map([source, row.input, ...result.evidence_files, result.raw_response,
        raw, localEvidence, observationRecord, ...(feature?.files ?? [])]
        .map(file => [path.resolve(file.path), file])).values()];
      await verifyEvidenceBindings(files);
      return { source_sha256: job.source_sha256, source_range: job.source_range,
        actual_audio_processed: true, model_revision: revision,
        observations: observation, observation_record: observationRecord, local_evidence: localEvidence,
        files, evidence_status: 'unqualified_research_prediction',
        artistic_approval: false, production_approval: false };
    };
  return { materialObserver_backend_id: 'local_specialist_receipts', materialObserver_model_revision: revision,
    materialObserver_audio_backend: backend, materialObserver: async (job, directory) => {
      const contexts = await verifyObservationContexts({ candidate: { source_sha256: job.source_sha256, source_range: job.source_range },
        observation_contexts: job.observation_contexts, bridge_recording_role: job.bridge_recording_role });
      const result = await observeWindow(job, directory), observations = [];
      for (const [index, context] of contexts.entries()) {
        const observed = await observeWindow({ ...job, source_range: context.source_range }, path.join(directory, 'context-' + index));
        observations.push({ source_sha256: job.source_sha256, source_range: context.source_range, context_only: true,
          purpose: context.purpose, actual_audio_processed: true, observation: observed.observations,
          observation_record: observed.observation_record, local_evidence: observed.local_evidence,
          files: observed.files, qualified: false, artistic_approval: false, Ready: false });
        result.files.push(...observed.files);
      }
      const human = await scopedHumanContextFacts(job.human_context_review, job.source_sha256,
        [job.source_range, ...contexts.map(context => context.source_range)]);
      if (observations.length || human) {
        const receipt = await saveJson(path.join(directory, 'observation-context-provenance.json'), {
          schema_version: 1, source_sha256: job.source_sha256, adoption_source_range_unchanged: job.source_range,
          primary_observation: result.observation_record, observation_contexts: observations, human_context_review: human,
          context_extends_adoption_or_reference_use: false, qualified: false, artistic_approval: false, Ready: false });
        result.files.push(receipt, ...(human ? [human.review] : []));
        result.observation_contexts = observations; result.human_context_review = human;
        result.context_provenance = receipt;
        await verifyEvidenceBindings(result.files);
      }
      return result;
    } };
}

export { bindSpecialistReceipt as bindSpecialistMaterialReceipt };
