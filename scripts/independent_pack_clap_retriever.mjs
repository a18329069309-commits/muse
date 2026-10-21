import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { createHash } from 'node:crypto';
import { resolveVerifiedRecordingFamily } from './music_family_identity.mjs';
import { validateIndependentPackRankingPolicy } from './independent_pack_ranking_policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const inside = (small, large) => Array.isArray(small) && Array.isArray(large)
  && small.length === 2 && large.length === 2 && small.every(Number.isFinite) && large.every(Number.isFinite)
  && 0 <= large[0] && large[0] <= small[0] && small[0] < small[1] && small[1] <= large[1]
  && small[1] - small[0] <= 10 + 1e-9;
const fail = message => { throw new Error(`independent_clap_${message}`); };

// One adapter owns one CPU text worker for its complete upload/batch session.
// The snapshot references a separate vector release, never changes music packs.
export async function createIndependentPackRetriever(config, runtime = {}) {
  const injected=typeof runtime.spawnWorker==='function';
  if(injected&&runtime.execution_kind!=='injected_test_transport')fail('explicit_test_transport_required');
  const spawnWorker=runtime.spawnWorker??spawn;
  if (config?.kind !== 'resident_clap' || !config.snapshot || !config.weights || !config.python) fail('config_required');
  if (config.device && config.device !== 'cpu') fail('text_worker_requires_cpu');
  const rankingPolicy = validateIndependentPackRankingPolicy(config.ranking_policy);
  await verifyEvidenceBindings(config.snapshot);
  const snapshot = await readJson(config.snapshot.path);
  if (snapshot.kind !== 'independent_resident_clap_snapshot') fail('snapshot_kind_invalid');
  await verifyEvidenceBindings([snapshot.index, snapshot.audio, snapshot.mapping, snapshot.music_publication]);
  const index = await readJson(snapshot.index.path), mapping = await readJson(snapshot.mapping.path);
  const publication = await readJson(snapshot.music_publication.path);
  const published = new Map((publication.windows ?? publication.packs?.flatMap(pack => pack.windows ?? []) ?? [])
    .map(window => [window.segment_id, window]));
  if (index.audio_sha256 !== snapshot.audio.sha256 || !same(mapping.publication, snapshot.music_publication)) fail('snapshot_binding_invalid');
  const rows = new Map(index.records.map(row => [row.segment_id, row]));
  const windows = new Map();
  for (const window of mapping.records) {
    const row = rows.get(window.segment_id);
    const source = published.get(window.segment_id);
    if (!row || windows.has(window.segment_id) || row.asset_id !== window.asset_id
      || row.source_sha256 !== window.source_sha256 || row.vector_sha256 !== window.vector_sha256
      || !same(row.source_range, window.representative_source_range)
      || (row.target_window_range && !same(row.target_window_range, window.source_range))
      || !inside(window.representative_source_range, window.source_range)
      || !source || source.asset_id !== window.asset_id || source.source_sha256 !== window.source_sha256
      || !same(source.source_range, window.source_range)) fail('window_mapping_invalid');
    windows.set(window.segment_id, window);
  }
  if (rows.size !== windows.size || rows.size !== index.records.length) fail('window_mapping_incomplete');
  const families = new Map();
  const familyRecordings = new Map((publication.packs ?? []).flatMap(pack => pack.recordings ?? [])
    .map(recording => [recording.asset_id, recording]));
  if (rankingPolicy) for (const [id, window] of windows) {
    const family = await resolveVerifiedRecordingFamily({ ...familyRecordings.get(window.asset_id), ...published.get(id) }, snapshot.music_publication);
    families.set(id, family?.family_id ?? null);
  }
  let child, ready, closed = false, sequence = 0, chain = Promise.resolve(), stderr = '';
  const pending = new Map();
  const timeout = config.timeout_ms ?? 120000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120000) fail('timeout_invalid');
  function start() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      child = spawnWorker(config.python, ['-X', 'utf8', path.join(here, 'independent_pack_clap_worker.py'),
        '--snapshot', config.snapshot.path, '--snapshot-sha256', config.snapshot.sha256,
        '--weights', config.weights], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' } });
      const timer = setTimeout(() => { child.kill(); reject(Error('independent_clap_startup_timeout')); }, timeout);
      child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => {
        clearTimeout(timer); reject(Error(`independent_clap_worker_exited:${code}:${stderr}`));
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error('independent_clap_worker_exited')); }
        pending.clear();
      });
      createInterface({ input: child.stdout }).on('line', line => {
        let message;
        try { message = JSON.parse(line); } catch { child.kill(); reject(Error('independent_clap_invalid_worker_json')); return; }
        if (message.status === 'ready') {
          clearTimeout(timer);
          if (message.snapshot_sha256 !== config.snapshot.sha256 || message.text_device !== 'cpu') {
            child.kill(); reject(Error('independent_clap_worker_ready_identity_mismatch')); return;
          }
          resolve(message); return;
        }
        const entry = pending.get(message.request_id);
        if (!entry) return;
        clearTimeout(entry.timer); pending.delete(message.request_id);
        if (message.status === 'query_failed') entry.reject(Error(`independent_clap_query_failed:${message.error}`));
        else entry.resolve(message);
      });
    });
    return ready;
  }
  async function checkpoint(context,stage){
    const budget=await context.trialBudget?.inspectLocal({stage});
    if(budget?.deadline_at_ms!=null){
      const value=budget.deadline_at_ms-(budget.reserved_render_ms??0);
      context.deadlineAtMs=Math.min(context.deadlineAtMs??Infinity,value);
    }
    if(context.deadlineAtMs!=null&&Date.now()>=context.deadlineAtMs)
      throw Object.assign(Error('independent_clap_episode_deadline_exhausted'),{
        code:'independent_clap_episode_deadline_exhausted',stage,shared_worker_killed:false,account_calls:0});
  }
  async function deadlineFailure(context,stage){
    try{await checkpoint(context,stage);}catch(error){return error;}
    return Object.assign(Error('independent_clap_episode_deadline_exhausted'),{
      code:'independent_clap_episode_deadline_exhausted',stage,shared_worker_killed:false,account_calls:0});
  }
  // A film may leave while a shared inference is finishing. Keep that pending
  // protocol response in the worker's serial chain; killing it would terminate
  // another film's shared worker. Expired queued requests never reach stdin.
  function waitForFilm(work,context){
    if(context.deadlineAtMs==null)return work;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(async()=>reject(await deadlineFailure(context,'independent_clap_film_wait_deadline')),
        Math.max(1,Math.min(2147483647,context.deadlineAtMs-Date.now())));
      work.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
    });
  }
  async function retrieve(query, outputDir, context) {
    await checkpoint(context,'independent_clap_queue_released');
    if (closed) fail('adapter_closed');
    const text = query.semantic_query_text || query.text;
    if (typeof text !== 'string' || !text.trim()) fail('nonempty_semantic_query_required');
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) fail('limit_invalid');
    if (!Array.isArray(query.candidate_scope)) fail('exact_candidate_scope_required');
    const allowed = new Set(), rankedScope = [];
    for (const item of query.candidate_scope) {
      const window = windows.get(item.segment_id);
      if (!window || (item.asset_id && item.asset_id !== window.asset_id)
        || (item.source_sha256 && item.source_sha256 !== window.source_sha256)
        || (item.source_range && !same(item.source_range, window.source_range))) fail('scope_outside_snapshot');
      if (rankingPolicy) {
        const family = families.get(item.segment_id), key = family ? `family:${family}` : `recording:${window.source_sha256}`;
        if (allowed.has(item.segment_id) || item.diversity_key !== key
          || item.family_id !== undefined && item.family_id !== family
          || item.vector_sha256 !== undefined && item.vector_sha256 !== window.vector_sha256
          || !Number.isSafeInteger(item.usage_count) || item.usage_count < 0 || item.usage_count > 1000000
          || ![0, 1].includes(item.preference)) fail('ranking_scope_family_or_history_invalid');
        rankedScope.push({ segment_id: window.segment_id, asset_id: window.asset_id,
          source_sha256: window.source_sha256, source_range: window.source_range,
          vector_sha256: window.vector_sha256, family_id: family, diversity_key: key,
          usage_count: item.usage_count, preference: item.preference });
      }
      allowed.add(item.segment_id);
    }
    if (!allowed.size) return { candidates: [], scope_filtered_before_limit: true,
      skipped_index_query: true, gaps: ['no_eligible_frozen_window'], audio_files_read: 0,
      artistic_approval: false };
    await checkpoint(context,'independent_clap_worker_admission');
    const workerReady = await start();
    await checkpoint(context,'independent_clap_query_submission');
    const request = { request_id: `independent-clap-${++sequence}`, text: text.slice(0, 2000),
      limit: query.limit, allowed_segment_ids: [...allowed], preserve_source_windows: true,
      verify_selected: false,
      ...(rankingPolicy ? { ranking_policy: rankingPolicy, candidate_scope: rankedScope,
        candidate_scope_sha256: createHash('sha256').update(JSON.stringify(rankedScope)).digest('hex') } : {}) };
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(request.request_id); child.kill(); reject(Error('independent_clap_query_timeout')); }, timeout);
      pending.set(request.request_id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(request) + '\n');
    });
    await checkpoint(context,'independent_clap_query_result');
    if (result.scope_filtered_before_limit !== true || !Array.isArray(result.candidates)) fail('worker_scope_evidence_missing');
    if (rankingPolicy && (result.ranking?.revision !== rankingPolicy.revision
      || !same(result.ranking.policy, rankingPolicy)
      || result.candidate_scope_sha256 !== request.candidate_scope_sha256
      || result.candidates.length > query.limit)) fail('worker_ranking_identity_mismatch');
    for (const candidate of result.candidates) {
      const window = windows.get(candidate.segment_id);
      if (!window || !allowed.has(candidate.segment_id) || candidate.asset_id !== window.asset_id
        || candidate.source_sha256 !== window.source_sha256 || !same(candidate.source_range, window.source_range)
        || !same(candidate.semantic_evidence_range, window.representative_source_range)
        || candidate.semantic_vector_sha256 !== window.vector_sha256) fail('worker_candidate_identity_mismatch');
      if (rankingPolicy) {
        const expected = rankedScope.find(row => row.segment_id === candidate.segment_id);
        if (!expected || candidate.ranking_evidence?.diversity_key !== expected.diversity_key
          || candidate.ranking_evidence?.usage_count !== expected.usage_count
          || candidate.ranking_evidence?.qualification_granted !== false
          || !(candidate.similarity > rankingPolicy.minimum_similarity)) fail('worker_ranking_scope_mismatch');
      }
    }
    const receipt = { ...result, snapshot: config.snapshot, music_publication: snapshot.music_publication,
      cpu_worker_resident: true, audio_files_read: 0, whole_window_encoded: false,
      source_verification: 'frozen_vector_identity_only_rehash_selected_recording_before_use',
      distinct_recording_sha_count: new Set(result.candidates.map(item => item.source_sha256)).size,
      distinct_recording_family_count: new Set(result.candidates.map(item => item.family_id || item.source_sha256)).size,
      worker_ready: workerReady, artistic_approval: false,
      ...(injected?{execution_kind:'injected_test_transport',actual_model_inference:false}:{}),
      ...(context.deadlineAtMs==null?{}:{episode_deadline_at_ms:context.deadlineAtMs,
        deadline_scope:'queue_startup_inference_wait_and_io_checkpoints',shared_worker_killed:false}) };
    await checkpoint(context,'independent_clap_receipt_io');
    if (outputDir) await saveJson(path.join(outputDir, 'resident-clap-recall.json'), { request, result: receipt });
    await checkpoint(context,'independent_clap_receipt_io_complete');
    return receipt;
  }
  return { async retrieve(query, outputDir, {trialBudget=null,deadlineAtMs=null}={}) {
    if(deadlineAtMs!==null&&(!Number.isSafeInteger(deadlineAtMs)||deadlineAtMs<=0))fail('episode_deadline_invalid');
    const context={trialBudget,deadlineAtMs};
    await checkpoint(context,'independent_clap_queue_admission');
    const next = chain.then(() => retrieve(query, outputDir, context));
    chain = next.catch(() => {}); return waitForFilm(next,context);
  }, close() { closed = true; child?.stdin.end(); child?.kill(); }, snapshot: config.snapshot };
}
