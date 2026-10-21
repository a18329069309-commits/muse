import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { readTargetAnalysis } from './prepare_target_materials.mjs';
import { createCaseMatcher } from './case_host_adapter.mjs';
import { selectMaterials } from './material_selection.mjs';
import { requestedWords, wordRequestMode, buildLyricRecallDirector } from './direction_semantics.mjs';
import { loadProjectTrialPolicy } from './project_trial_gate.mjs';
import { loadCompletedMusicHistory } from './cross_work_music_gate.mjs';
import { loadOfflineHumanReview } from './music_profile.mjs';
import { prepareTargetSfxMaterials, loadTargetSfxLibrary } from './target_sfx_material_bridge.mjs';

const run = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const load = async reference => { await verifyEvidenceBindings(reference); return readJson(reference.path); };
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const inside = (a, b) => range(a) && range(b) && a[0] >= b[0] && a[1] <= b[1];
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
const text = value => typeof value === 'string' && value.trim();

// Use the registered SQLite reader and pointer verifier already used by corpus_materials.
// The Python process only retrieves and validates files. It does not choose or hear music.
const retrievalProgram = `import sys,json,pathlib,hashlib
sys.path.insert(0,sys.argv[1])
import segment_library,corpus_materials
from registered_library_connection import readonly_registered_library
from contextlib import closing
document=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8-sig'))
tasks=json.loads(pathlib.Path(sys.argv[3]).read_text(encoding='utf-8-sig'))
evidence=json.loads(sys.argv[6]); results=[]; sources=[]; cache={}
by_case={row['case_id']:row for row in document['cases']}
with closing(readonly_registered_library(sys.argv[4])) as db:
 for task in tasks['tasks']:
  case=by_case[task['case_id']];query=task['query']
  result=segment_library.query_library(sys.argv[4],**query);candidates=[];gaps=[]
  event=next(row for row in case['source_events'] if row['event_id']==task['source_event_id'])
  for candidate in result['candidates']:
   pointer={key:candidate[key] for key in ('asset_id','segment_id','source_sha256','source_range')}
   try:corpus_materials.verify_pointer(db,pointer,pathlib.Path(sys.argv[2]).parent,sources,cache)
   except (ValueError,OSError):
    gaps.append({'segment_id':pointer['segment_id'],'gap':'candidate_source_or_window_changed'});continue
   token=hashlib.sha256(json.dumps([case['case_id'],pointer['asset_id'],pointer['source_sha256']],sort_keys=True).encode()).hexdigest()[:24]
   item={**pointer,'step_id':task['step_id'],'status':'research','source_relation':'candidate_substitute',
    'reason':task['reason'],'pack_id':'research-candidate/'+token,'window_id':pointer['segment_id'],'phase':candidate['phase']}
   mapping={'case_id':case['case_id'],'source_video_sha256':document['episodes'][0]['source_video']['sha256'],
    'case_source_range':case['source_range'],'evidence_files':evidence+case['evidence']['files'], 'music':[item],'sounds':[]}
   candidates.append({'candidate':candidate,'source_file':{'path':candidate['local_path'],'sha256':pointer['source_sha256']},
    'binding':mapping,'selected':False,'listening_verified':False})
  results.append({'case_id':case['case_id'],'step_id':task['step_id'],'source_event_id':task['source_event_id'],
   'reference_event':event,'reason':task['reason'],'attempts':[{'query':query,'retrieval':result}],
   'candidates':candidates,'gaps':gaps,'candidate_limit_distinct_recordings':5})
output={'schema_version':1,'tasks':results,'evidence_files':evidence,'source_files':sources,
 'automatic_selection_performed':False,'artistic_approval':False,'production_approval':False}
pathlib.Path(sys.argv[5]).write_text(json.dumps(output,ensure_ascii=False,indent=2),encoding='utf-8')
`;

async function databaseBinding(value, name) {
  const file = typeof value === 'string' ? value : value?.path ?? value?.db;
  if (!path.isAbsolute(file ?? '')) throw Error(`target_music_frozen_${name}_required`);
  const reference = await bound(file);
  if (value?.sha256 && value.sha256 !== reference.sha256) throw Error(`target_music_${name}_changed`);
  return reference;
}

async function targetInputs(config, analysisBinding, directionBinding, frames) {
  const encoded = await load(analysisBinding);
  let analysis, analysisRef, manifestRef, manifest, source, catalog;
  if (encoded.kind === 'target_analysis') {
    const data = await readTargetAnalysis(analysisBinding, config);
    analysis = data.analysis; analysisRef = data.target.analysis; manifestRef = data.target.manifest;
    manifest = data.manifest; source = data.target.source_video;
    catalog = { source_video_sha256: source.sha256, evidence: data.request.evidence_catalog.map(row => ({
      ...row, ...(data.request.bindings ?? []).find(binding => binding.id === row.id) })) };
  } else {
    analysis = encoded; analysisRef = analysisBinding;
    source = await databaseBinding(config.video ?? config.source_video, 'source_video');
    manifestRef = await databaseBinding(config.manifest ?? config.prepared_manifest_binding?.manifest, 'manifest');
    manifest = await load(manifestRef);
    catalog = config.evidence_catalog ? await load(config.evidence_catalog) : {
      source_video_sha256: source.sha256, evidence: frames.map(frame => ({ ...frame, kind: 'frame' })) };
  }
  for (const row of catalog.evidence ?? []) if (row.kind === 'audio_observation') {
    const observation = await readJson(row.path);
    row.source_video_sha256 = observation.source_video_sha256;
    row.source_sha256 = observation.source_sha256;
    row.verified = false; row.qualified = false; row.sound_facts_qualified = false;
  }
  const wrapper = await load(directionBinding), direction = wrapper.direction ?? wrapper;
  if (wrapper.analysis && wrapper.analysis.sha256 !== analysisRef.sha256) throw Error('target_music_direction_analysis_changed');
  const duration = manifest.timeline?.duration_samples / 48000;
  if (analysis.source_video_sha256 !== source.sha256 || manifest.source_sha256 !== source.sha256
    || (wrapper.source_video_sha256 ?? direction.source_video_sha256) !== source.sha256
    || !Number.isFinite(duration) || duration <= 0 || manifest.timeline?.sample_rate !== 48000)
    throw Error('target_music_source_or_clock_mismatch');
  await verifyEvidenceBindings([source, manifestRef, analysisRef, directionBinding, frames, catalog.evidence]);
  const beatIds = new Set((analysis.story_beats ?? []).map(beat => beat.id));
  const evidenceIds = new Set((catalog.evidence ?? []).map(row => row.id));
  if (!beatIds.size || beatIds.size !== analysis.story_beats.length || !evidenceIds.size
    || analysis.story_beats.some(beat => !inside([beat.start_seconds, beat.end_seconds], [0, duration])
      || !beat.evidence_ids?.length || beat.evidence_ids.some(id => !evidenceIds.has(id))))
    throw Error('target_music_bound_story_evidence_required');
  if (!['auto', 'male', 'female'].includes(direction.audience) || !direction.cues?.length
    || new Set(direction.cues.map(cue => cue.cue_id)).size !== direction.cues.length
    || direction.cues.some(cue => !text(cue.cue_id) || !text(cue.function) || !text(cue.sound_goal)
      || !inside(cue.target_range, [0, duration]) || !cue.story_beat_ids?.length
      || cue.story_beat_ids.some(id => !beatIds.has(id)
        || !overlap(cue.target_range, [analysis.story_beats.find(beat => beat.id === id).start_seconds,
          analysis.story_beats.find(beat => beat.id === id).end_seconds]))))
    throw Error('target_music_cue_actual_story_links_required');
  return { analysis, analysisRef, manifestRef, manifest, source, catalog, duration,
    director: { ...structuredClone(direction), schema_version: 1, source_video_sha256: source.sha256,
      usage_scope: 'research_noncommercial' } };
}

function projectTarget(data, bindings) {
  const episodeId = `current-target/${data.source.sha256}`, tasks = [], links = [], cases = [];
  for (const cue of data.director.cues) {
    const beats = data.analysis.story_beats.filter(beat => cue.story_beat_ids.includes(beat.id));
    const caseId = `${episodeId}/${encodeURIComponent(cue.cue_id)}`;
    const events = beats.map(beat => ({ event_id: beat.id, kind: 'story',
      source_range: [Math.max(cue.target_range[0], beat.start_seconds), Math.min(cue.target_range[1], beat.end_seconds)],
      description: beat.sound_decision, observation_ids: beat.evidence_ids }));
    const item = { case_id: caseId, episode_id: episodeId, source_range: cue.target_range, status: 'research',
      source_role: 'current_unscored_target_not_reference_success_case', description: cue.sound_goal,
      conditions: cue.case_conditions ?? {}, exclude_case_conditions: cue.exclude_case_conditions ?? [],
      story_sequence: cue.story_sequence ?? [], source_events: events, music_pack_ids: [], sound_pack_ids: [], theme_bundle_ids: [],
      development_preset: { steps: [] }, evidence: { source_video_sha256: data.source.sha256,
        source_range: cue.target_range, observation_ids: [...new Set(events.flatMap(event => event.observation_ids))],
        files: bindings, actual_audio_processed: false, artistic_approval: false,
        evidence_status: 'current_bound_story_music_intention_not_successful_reference' } };
    for (const kind of ['music', ...(requestedWords(cue) ? ['words'] : [])]) {
      const stepId = `${cue.cue_id}/${kind}`, event = events[0];
      item.development_preset.steps.push({ step_id: stepId, story_step_id: cue.story_sequence?.[0]?.step_id ?? event.event_id,
        source_event_id: event.event_id, action: 'compare_current_' + kind, anchor: event.event_id,
        target_range: cue.target_range, development_description: kind === 'words' ? cue.words_function : cue.sound_goal,
        music_pack_ids: [], sound_pack_ids: [], window_refs: [] });
      const queryText = kind === 'words' ? cue.words_audio_retrieval_query ?? cue.words_function ?? cue.sound_goal
        : cue.audio_retrieval_query ?? cue.music_audio_retrieval_query ?? cue.style_text ?? cue.sound_goal;
      tasks.push({ case_id: caseId, step_id: stepId, source_event_id: event.event_id,
        source_video_sha256: data.source.sha256,
        reason: `${cue.function}: ${queryText}; current story and actual source windows require comparison`,
        query: { asset_kind: 'music', text: queryText, usage_scope: 'research_noncommercial', preserve_source_windows: true,
          ...(kind === 'words' ? { vocals: 'sung', discover_unknown_vocals: true } : {}) } });
      links.push({ case_id: caseId, target_case_id: caseId, step_id: stepId, target_step_id: stepId,
        source_video_sha256: data.source.sha256, cue_id: kind === 'words' ? cue.cue_id + '/words' : cue.cue_id,
        parent_cue_id: cue.cue_id, kind, target_range: cue.target_range, story_beat_ids: cue.story_beat_ids,
        words_request: kind === 'words' ? wordRequestMode(cue) : null, vocal_language: cue.vocal_language ?? 'unknown' });
    }
    cases.push(item);
  }
  return { links, tasks, document: { schema_version: 2,
    works: [{ work_id: episodeId, title: 'Current unscored target', split: 'research' }],
    episodes: [{ episode_id: episodeId, work_id: episodeId, source_video: data.source, media_status: 'local_verified' }],
    cases, packs: [], sound_packs: [], theme_bundles: [], artistic_approval: false, production_approval: false } };
}

async function historyExclusions(config, data, outputDir) {
  const loaded = await loadProjectTrialPolicy(config, { cwd: outputDir, inputFiles: [data.source.path],
    ...(config.project_policy_path ? { policyPath: config.project_policy_path } : {}) });
  if (loaded?.gap) return { excluded: [], gaps: [{ gap: loaded.gap.code, blocks_render: true }], policy: loaded.binding };
  const policy = loaded?.policy?.cross_work_music;
  if (policy?.status !== 'active') return { excluded: [], gaps: [], status: 'no_active_cross_work_policy' };
  const identities = await Promise.all((policy.work_identity_index ?? []).map(load));
  const current = identities.filter(row => row.kind === 'host_validated_work_identity' && row.source?.sha256 === data.source.sha256);
  if (!current.length || new Set(current.map(row => row.work_id)).size !== 1)
    return { excluded: [], gaps: [{ gap: 'cross_work_current_work_identity_missing', blocks_render: true }], policy: loaded.binding };
  const history = await loadCompletedMusicHistory(policy);
  const excluded = [...new Set(history.filter(row => row.source.sha256 !== data.source.sha256 && row.work?.id !== current[0].work_id)
    .flatMap(row => row.dominant_recording_sha256))];
  return { excluded, gaps: [], policy: loaded.binding, work_id: current[0].work_id,
    history_deliveries: history.map(row => row.delivery), status: 'actual_other_work_dominant_recordings_excluded_before_selection' };
}

async function recallCases(config, data, database, library, outputDir, session, runtime) {
  const matcher = runtime.caseMatcher ?? (['codex_cli', 'codex_host_file'].includes(session?.backend_kind)
    ? createCaseMatcher({ python: config.python, candidatePool: config.cases?.semantic_candidate_pool }) : null);
  const attempts = [], routes = new Map();
  for (const limit of [20, 50]) {
    const directory = path.join(outputDir, `case-recall-${limit}`); await mkdir(directory, { recursive: true });
    const query = await saveJson(path.join(directory, 'query.json'), { schema_version: 2,
      source_video_sha256: data.source.sha256, store_sha256: database.sha256, usage_scope: 'research_noncommercial',
      sequence_match: 'ordered_compatible', limit, story_beats: data.analysis.story_beats,
      music_actions: data.director.music_actions ?? [], cues: buildLyricRecallDirector(data.director).cues });
    let result;
    if (matcher) result = await matcher({ query, database, library_db: library.path, output_dir: directory }, session);
    else {
      const file = path.join(directory, 'routes.json');
      await run(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'case_preset_store.py'), 'query', '--db', database.path,
        '--input', query.path, '--library-db', library.path, '--output', file], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      result = await readJson(file);
    }
    await verifyEvidenceBindings([database, library]);
    if (result.source_video_sha256 !== data.source.sha256 || result.store_sha256 !== database.sha256
      || !Array.isArray(result.routes)) throw Error('target_music_actual_case_route_identity_required');
    const response = await saveJson(path.join(directory, 'received-routes.json'), result); attempts.push({ limit, query, response });
    for (const route of result.routes) routes.set(route.route_id, route);
    if (buildLyricRecallDirector(data.director).cues.every(cue => [...routes.values()].some(route => route.cue_id === cue.cue_id
      && route.source_candidates?.length))) break;
  }
  return { routes: [...routes.values()], attempts };
}

// This consumes real callbacks now; missing callbacks yield scoped gaps rather than an unattended request producer.
export async function prepareTargetResearchMaterials({ config, analysisBinding, directionBinding, frames = [], session,
  runtime = {}, outputDir = config?.output_dir }) {
  if (config?.mode !== 'research' || config.automatic_trial !== true || !path.isAbsolute(outputDir ?? ''))
    throw Error('target_music_explicit_automatic_research_trial_required');
  await mkdir(outputDir, { recursive: true });
  const data = await targetInputs(config, analysisBinding, directionBinding, frames);
  const missingStores = ['library', 'cases'].filter(name => !path.isAbsolute(typeof config[name] === 'string'
    ? config[name] : config[name]?.path ?? config[name]?.db ?? ''));
  if (missingStores.length) {
    const unavailable = { schema_version: 1, status: 'target_research_material_gap', source_video_sha256: data.source.sha256,
      target_analysis: analysisBinding, direction: directionBinding, Ready: false, qualified: false,
      production_approval: false, artistic_approval: false, render_calls: 0, generation_calls: 0,
      gaps: data.director.cues.flatMap(cue => missingStores.map(name => ({ cue_id: cue.cue_id,
        target_range: cue.target_range, story_beat_ids: cue.story_beat_ids, kind: 'music',
        gap: `frozen_${name}_required`, blocks_render: true }))) };
    unavailable.artifact = await saveJson(path.join(outputDir, 'target-research-materials.json'), unavailable);
    return unavailable;
  }
  const library = await databaseBinding(config.library, 'library'), database = await databaseBinding(config.cases, 'cases');
  const record = { schema_version: 1, source_video_sha256: data.source.sha256, target_analysis: analysisBinding,
    direction: directionBinding, library, case_database: database, render_calls: 0, generation_calls: 0,
    Ready: false, qualified: false, artistic_approval: false, production_approval: false, gaps: [], candidate_handoffs: [] };
  const finish = async values => { Object.assign(record, values);
    record.artifact = await saveJson(path.join(outputDir, 'target-research-materials.json'), record); return record; };
  const history = await historyExclusions(config, data, outputDir); record.cross_work_preselection = history;
  if (history.gaps.length) return finish({ status: 'target_research_material_gap', gaps: history.gaps });
  const recalled = await recallCases(config, data, database, library, outputDir, session, runtime);
  record.reference_case_recall = recalled.attempts;
  const projected = projectTarget(data, [analysisBinding, data.analysisRef, directionBinding, data.manifestRef, library, database]);
  const caseInput = await saveJson(path.join(outputDir, 'current-case-input.json'), projected.document);
  const director = await saveJson(path.join(outputDir, 'current-director.json'), data.director);
  const catalog = await saveJson(path.join(outputDir, 'evidence-catalog.json'), data.catalog);
  const missing = [];
  for (const task of projected.tasks) {
    const link = projected.links.find(row => row.case_id === task.case_id && row.step_id === task.step_id);
    const routes = recalled.routes.filter(row => row.cue_id === link.cue_id);
    const ids = [...new Set(routes.flatMap(route => route.source_candidates ?? []).map(candidate => candidate.segment_id))];
    if (ids.length) { task.query.text = ''; task.query.candidate_segment_ids = ids.slice(0, 100); }
    else if (config.strategy === 'case_presets') missing.push({ ...link, gap: 'case_route_actual_material_missing',
      blocks_render: link.kind === 'music' || link.words_request === 'require' });
  }
  const active = projected.tasks.filter(task => !missing.some(row => row.case_id === task.case_id && row.step_id === task.step_id));
  record.gaps.push(...missing);
  if (!active.length) return finish({ status: 'target_research_material_gap', current_case: caseInput });
  if (typeof runtime.materialObserver !== 'function' || typeof runtime.materialSelector !== 'function')
    return finish({ status: 'target_research_material_gap', current_case: caseInput, gaps: [...record.gaps,
      ...projected.links.filter(link => active.some(task => task.step_id === link.step_id && task.case_id === link.case_id)).map(link => ({
        ...link, gap: typeof runtime.materialObserver !== 'function' ? 'candidate_audio_observation_pending' : 'material_selector_runtime_missing',
        blocks_render: link.kind === 'music' || link.words_request === 'require' }))] });
  const selections = [], candidateDocuments = [], selectedBindings = new Map(), observedCache = new Map();
  const materialRuntime = { ...runtime, materialObserver: async (job, directory) => {
    const key = JSON.stringify([job.source_sha256, job.source_range, job.observation_contexts ?? null]);
    if (!observedCache.has(key)) observedCache.set(key, await runtime.materialObserver(job, directory));
    return observedCache.get(key);
  } };
  let pendingTasks = active;
  for (const limit of [20, 50]) {
    if (!pendingTasks.length) break;
    const directory = path.join(outputDir, `material-recall-${limit}`); await mkdir(directory, { recursive: true });
    const tasks = await saveJson(path.join(directory, 'tasks.json'), { schema_version: 1,
      tasks: pendingTasks.map(task => ({ ...task, query: { ...task.query, limit } })) });
    const candidateFile = path.join(directory, 'candidates.json');
    await run(config.python ?? 'python', ['-X', 'utf8', '-c', retrievalProgram, here, caseInput.path, tasks.path,
      library.path, candidateFile, JSON.stringify([caseInput, tasks, library, database, ...recalled.attempts.flatMap(row => [row.query, row.response])])],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    await verifyEvidenceBindings([caseInput, tasks, library, database]);
    const candidateDocument = await readJson(candidateFile), excluded = new Set(history.excluded);
    for (const task of candidateDocument.tasks) {
      const link = projected.links.find(row => row.case_id === task.case_id && row.step_id === task.step_id);
      const routeCandidates = recalled.routes.filter(route => route.cue_id === link.cue_id)
        .flatMap(route => route.source_candidates ?? []);
      task.candidates = task.candidates.flatMap(candidate => {
        if (excluded.has(candidate.candidate.source_sha256)) return [];
        const supplied = routeCandidates.find(row => row.segment_id === candidate.candidate.segment_id
          && row.source_sha256 === candidate.candidate.source_sha256);
        if (!supplied) return [candidate];
        const permitted = supplied.case_source_range ?? supplied.source_range;
        const actual = candidate.candidate.source_range;
        if (!range(permitted) || !overlap(permitted, actual)) return [];
        const adopted = [Math.max(permitted[0], actual[0]), Math.min(permitted[1], actual[1])];
        candidate.candidate.source_range = adopted;
        candidate.binding.music[0].source_range = adopted;
        candidate.reference_source_window = supplied;
        return [candidate];
      });
    }
    const admitted = await saveJson(path.join(directory, 'admitted-candidates.json'), candidateDocument);
    candidateDocuments.push({ limit, candidate: admitted, tasks });
    const selection = await selectMaterials({ candidate_file: admitted.path, input_file: caseInput.path,
      output_dir: path.join(directory, 'selection') }, materialRuntime);
    const selectionRef = await bound(path.join(directory, 'selection/selection-record.json'));
    selections.push({ limit, selection: selectionRef });
    if (selection.bindings_file) {
      const encoded = await load(selection.bindings_file);
      for (const mapping of encoded.bindings) {
        const prior = selectedBindings.get(mapping.case_id) ?? { ...mapping, music: [], sounds: [], evidence_files: [] };
        prior.music.push(...mapping.music); prior.evidence_files = unique([...prior.evidence_files, ...mapping.evidence_files]);
        selectedBindings.set(mapping.case_id, prior);
      }
    }
    const selectedSteps = new Set([...selectedBindings.values()].flatMap(mapping => mapping.music.map(music => `${mapping.case_id}:${music.step_id}`)));
    pendingTasks = active.filter(task => !selectedSteps.has(`${task.case_id}:${task.step_id}`));
  }
  record.material_recall_attempts = candidateDocuments; record.material_selections = selections;
  for (const task of pendingTasks) {
    const link = projected.links.find(row => row.case_id === task.case_id && row.step_id === task.step_id);
    record.gaps.push({ ...link, gap: 'no_actual_selected_material_after_20_then_50',
      blocks_render: link.kind === 'music' || link.words_request === 'require' });
  }
  const combinedBindings = await saveJson(path.join(outputDir, 'selected-bindings.json'), { schema_version: 1,
    bindings: [...selectedBindings.values()], selection_records: selections, artistic_approval: false, production_approval: false });
  record.selected_bindings = combinedBindings;
  if (!selectedBindings.size) return finish({ status: 'target_research_material_gap', current_case: caseInput });
  const materialsFile = path.join(outputDir, 'current-materials.json');
  await run(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'corpus_materials.py'), '--input', caseInput.path,
    '--bindings', combinedBindings.path, '--library-db', library.path, '--output', materialsFile],
  { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const music = [], words = [], routes = [], sourceDescriptors = new Map();
  const suppliedProvenance = config.music_source_provenance ? await load(config.music_source_provenance) : { sources: [] };
  for (const mapping of selectedBindings.values()) for (const item of mapping.music) {
    const link = projected.links.find(row => row.case_id === mapping.case_id && row.step_id === item.step_id);
    let selectionRef, selector;
    for (const row of selections) {
      const value = await load(row.selection);
      if (value.bindings_file && (await load(value.bindings_file)).bindings.some(binding => binding.case_id === mapping.case_id
        && binding.music.some(candidate => candidate.step_id === item.step_id && candidate.segment_id === item.segment_id))) {
        selectionRef = row.selection; selector = value; break;
      }
    }
    if (!selector) throw Error('target_music_selected_window_receipt_missing');
    const observation = { ...item.listening_evidence, source_sha256: item.source_sha256, source_range: item.source_range,
      actual_audio_processed: true, actual_audio_listened: false, qualified: false, production_approval: false };
    const token = shaBytes(JSON.stringify([mapping.case_id, item.step_id, item.segment_id])).slice(0, 20);
    const observationRef = observation.observation_record ?? await saveJson(path.join(outputDir, `observation-${token}.json`), observation);
    await verifyEvidenceBindings(observationRef);
    const actualObservation = await load(observationRef);
    if (actualObservation.actual_audio_processed !== true || actualObservation.source_sha256 !== item.source_sha256
      || !inside(item.source_range, actualObservation.source_range)) throw Error('target_music_actual_observation_window_mismatch');
    const selection = await saveJson(path.join(outputDir, `selection-${token}.json`), { schema_version: 1,
      source_video_sha256: data.source.sha256, decisions: [{ cue_id: link.cue_id, selected_segment_id: item.segment_id,
        selected_source_range: item.source_range, reason: item.reason }],
      selection_provenance: { selector_record: selectionRef, raw_response: selector.raw_response, case_input: caseInput } });
    const reference = recalled.routes.find(route => route.cue_id === link.cue_id && route.source_candidates?.some(candidate =>
      candidate.segment_id === item.segment_id && candidate.source_sha256 === item.source_sha256));
    const routeId = `current-research/${token}`;
    let local;
    for (const row of candidateDocuments) for (const task of (await load(row.candidate)).tasks)
      for (const candidate of task.candidates) if (candidate.candidate.segment_id === item.segment_id
        && candidate.candidate.source_sha256 === item.source_sha256) local = candidate.candidate.local_path;
    if (!local) throw Error('target_music_selected_source_path_missing');
    const referencedWindow = reference?.source_candidates?.find(row => row.segment_id === item.segment_id && row.source_sha256 === item.source_sha256);
    const allowedTarget = range(referencedWindow?.allowed_target_range)
      ? [Math.max(link.target_range[0], referencedWindow.allowed_target_range[0]), Math.min(link.target_range[1], referencedWindow.allowed_target_range[1])]
      : link.target_range;
    if (!range(allowedTarget)) throw Error('target_music_reference_target_mapping_outside_current_cue');
    const candidate = { ...item, local_path: local, cue_id: link.cue_id, parent_cue_id: link.parent_cue_id,
      target_case_id: mapping.case_id, target_step_id: item.step_id, music_pack_id: item.pack_id,
      case_route_id: routeId, case_ids: reference?.case_ids ?? [], allowed_target_range: allowedTarget,
      observation_record: observationRef, selection_record: selection, selection_source_ranges: [item.source_range],
      evidence_status: 'unqualified_research_prediction', source_identity_verified_by_retrieval: true };
    const handoff = await saveJson(path.join(outputDir, `handoff-${token}.json`), { schema_version: 1,
      source_video_sha256: data.source.sha256, target_case_id: mapping.case_id, target_step_id: item.step_id,
      cue_id: link.cue_id, kind: link.kind, selected_bindings: combinedBindings, selection: selectionRef,
      source_range: item.source_range, target_range: link.target_range, observation: observationRef,
      original_case_routes: reference ? [reference] : [], qualified: false, Ready: false, production_approval: false });
    record.candidate_handoffs.push(handoff);
    if (link.kind === 'words') {
      let facts = null, human = null;
      if (referencedWindow?.human_review_record) {
        try {
          human = await loadOfflineHumanReview(referencedWindow.human_review_record, { sourceSha: item.source_sha256,
            caseIds: reference.case_ids, requireWords: true });
          facts = human.record.words;
        } catch { /* Keep the actual scope failure as a words gap; other music continues. */ }
      }
      const language = facts?.vocal_language ?? facts?.language;
      if (facts?.complete_phrase !== true || !range(facts.source_range)
        || !inside(facts.source_range, item.source_range) || !text(language) || language === 'unknown'
        || link.vocal_language !== 'unknown' && language !== link.vocal_language) {
        record.gaps.push({ ...link, gap: 'actual_complete_phrase_boundary_or_language_unknown', candidate_handoff: handoff,
          blocks_render: link.words_request === 'require' });
        continue;
      }
      candidate.source_range = [...facts.source_range];
      candidate.selection_source_ranges = [[...facts.source_range]];
      candidate.offline_observation = { words: facts };
      candidate.human_review_record = human.binding;
      words.push(candidate);
    } else music.push(candidate);
    routes.push({ route_id: routeId, cue_id: link.cue_id, strategy: 'current_director_research',
      target_case_id: mapping.case_id, case_ids: candidate.case_ids, music_pack_id: item.pack_id,
      reference_case_route_id: reference?.route_id ?? null, source_candidates: [{ ...candidate }],
      artistic_approval: false, production_approval: false });
    const descriptor = suppliedProvenance.sources?.find(row => row.asset_id === item.asset_id && row.source_sha256 === item.source_sha256);
    const referenceCandidate = reference?.source_candidates?.find(row => row.segment_id === item.segment_id && row.source_sha256 === item.source_sha256);
    sourceDescriptors.set(item.asset_id, descriptor ?? (reference?.reference_case_binding && referenceCandidate?.original_recording_evidence
      ? { asset_id: item.asset_id, source_sha256: item.source_sha256, origin: 'hot_drama',
        reference_case_binding: reference.reference_case_binding, identity: { support_range: referenceCandidate.source_range,
          original_recording_evidence: referenceCandidate.original_recording_evidence } }
      : { asset_id: item.asset_id, source_sha256: item.source_sha256, origin: 'unknown' }));
  }
  const soundMaterials = await prepareTargetSfxMaterials({ config, analysisBinding: data.analysisRef, directionBinding: director,
    currentCaseBinding: caseInput, source: data.source, manifestBinding: data.manifestRef,
    libraryBinding: await loadTargetSfxLibrary(config, library),
    evidenceCatalogBinding: catalog, frames, session, runtime, outputDir: path.join(outputDir, 'sounds') });
  record.sound_materials = soundMaterials.artifact; record.sound_gaps = soundMaterials.gaps;
  const candidates = await saveJson(path.join(outputDir, 'candidates.json'), { schema_version: 1,
    source_video_sha256: data.source.sha256, music, words, sounds: soundMaterials.sounds,
    sound_event_guidance: soundMaterials.event_decisions, sound_material_gaps: soundMaterials.gaps,
    artistic_approval: false, production_approval: false });
  const caseRoutes = await saveJson(path.join(outputDir, 'case-routes.json'), { schema_version: 1,
    source_video_sha256: data.source.sha256, store_sha256: database.sha256, routes,
    reference_recall_attempts: recalled.attempts, formal_adoption_allowed: false, production_approval: false });
  const provenance = await saveJson(path.join(outputDir, 'music-source-provenance.json'), { schema_version: 1,
    sources: [...sourceDescriptors.values()], source_ratio_policy: 'existing_renderer_70_percent_rule_unchanged', production_approval: false });
  await verifyEvidenceBindings([analysisBinding, directionBinding, library, database, candidates, caseRoutes, provenance]);
  let currentMaterials = await bound(materialsFile);
  if (soundMaterials.current_materials) {
    const musicMaterials = await load(currentMaterials), sounds = await load(soundMaterials.current_materials);
    currentMaterials = await saveJson(path.join(outputDir, 'current-materials-with-sounds.json'), { ...musicMaterials,
      cases: [...musicMaterials.cases, ...sounds.cases], sound_packs: [...(musicMaterials.sound_packs ?? []), ...sounds.sound_packs],
      material_sound_preparation: soundMaterials.artifact, artistic_approval: false, production_approval: false });
  }
  const prepared = { manifest: data.manifestRef, analysis: data.analysisRef, director, evidence_catalog: catalog,
    candidates, current_materials: currentMaterials, case_routes: caseRoutes, music_source_provenance: provenance,
    audience: data.director.audience,
    ...(config.ambient_library ? { ambient_library: config.ambient_library } : {}),
    ...(config.original_sound_reviews ? { original_sound_reviews: config.original_sound_reviews } : {}) };
  return finish({ status: record.gaps.some(gap => gap.blocks_render) ? 'target_research_material_gap' : 'target_research_materials_selected',
    ...prepared, prepared_assembly_config: prepared, selected_count: music.length + words.length,
    actual_asset_selection_performed: true, actual_audio_processed: music.length + words.length > 0 });
}
