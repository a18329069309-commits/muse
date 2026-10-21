import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings, objectSchema, validateSchema, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { expandCandidateEvidence } from './candidate_evidence.mjs';
import { selectMaterials } from './material_selection.mjs';
import { loadOfflineHumanReview } from './music_profile.mjs';
import { isIndependentMusicPackTrial, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { measureDiagnosticSfxAnchor } from './diagnostic_sfx_anchor.mjs';
import {measureDiagnosticBedPlacement} from './diagnostic_bed_placement.mjs';
import { findOriginalSoundEventReview } from './original_sound_event_review.mjs';
import {normalizeSoundRetrievalQuery} from './sound_retrieval_contract.mjs';
import {resolveSoundCatalogFunction} from './sound_catalog_function_resolution.mjs';
import {resolveSoundCatalogueLexicalAliases} from './sound_catalogue_lexical_aliases.mjs';
import {writeSoundQueryCompletionRequests} from './sound_query_contract.mjs';
import {completeSoundQueryRequest,mergeSoundQueryCompletions} from './sound_query_completion.mjs';
import {assemblySfxAdoptionEnabled,prepareAssemblySfxPool} from './assembly_sfx_adoption.mjs';
import { loadCompletedTargetSfxSelection } from './completed_sfx_material_recovery.mjs';
import {repairTargetSoundQueryBatch} from './target_sound_query_repair_batch.mjs';
import {soundQueryFieldProjectionRevision} from './sound_query_contract.mjs';
import {sfxMaterialSelectionProjectionRevision} from './sfx_material_selection_projection.mjs';
import {createSfxClapRetriever,resolveSfxSemanticCandidates} from './sfx_clap_retriever.mjs';
import {sfxEventFunctionRevision,soundEventFunctionIntent,validateSelectedSoundUsage} from './sfx_event_function.mjs';
import {observedAssemblySfxPoolEnabled,assemblySfxCandidatePoolRevision,prepareObservedAssemblySfxPool} from './assembly_sfx_candidate_pool.mjs';

const run = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const load = async reference => { await verifyEvidenceBindings(reference); return readJson(reference.path); };
const text = value => typeof value === 'string' && Boolean(value.trim());
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] >= 0 && value[1] > value[0];
const inside = (a, b) => range(a) && range(b) && a[0] >= b[0] && a[1] <= b[1];
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const existingJson=async file=>{try{return await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const strings = { type: 'array', items: { type: 'string' } };
export const targetSfxDecisionSchema = objectSchema({ decisions: { type: 'array', items: objectSchema({
  event_id: { type: 'string' }, decision: { type: 'string', enum: ['new_asset', 'omit'] },
  selected_segment_id: { type: ['string', 'null'] }, selected_source_range: { type: ['array', 'null'],
    items: { type: 'number' }, minItems: 2, maxItems: 2 },
  source_anchor_seconds: { type: ['number', 'null'] }, reason: { type: 'string' },
}) }, review_pending: strings });

const omission = (event, reason, gap = null) => ({ event_id: event.id, role: event.role, decision: 'omit',
  original_status: 'unknown', preserve_original_track: true, selected_segment_id: null,
  selected_source_range: null, source_anchor_seconds: null, reason, ...(gap ? { gap } : {}) });

// Immutable request/result artifacts plus a write-before-submit marker prevent an
// interrupted query-only request from consuming another account slot on resume.
export async function repairTargetSoundQuery({query,event,analysisBinding,directionBinding,source,frames=[],session,outputDir}){
  const initial=normalizeSoundRetrievalQuery(query,event),queueFile=path.join(outputDir,'completion-queue.json');
  let queued=await existingJson(queueFile),queue;
  if(queued){
    queue=await bind(queueFile);await verifyEvidenceBindings([queued.analysis,queued.director,queued.requests]);
    if(queued.analysis.sha256!==analysisBinding.sha256||queued.director.sha256!==directionBinding.sha256
      ||queued.source_video_sha256!==source.sha256||queued.requests.length!==1)throw Error('target_sfx_query_repair_binding_changed');
    const request=await load(queued.requests[0]);
    if(!same(request.data.query_repair_event_ids,[event.id])||!same(request.data.events,[event])
      ||!same(request.data.existing_sound_queries,[query]))throw Error('target_sfx_query_repair_scope_mismatch');
  }else{
    queue=await writeSoundQueryCompletionRequests({analysis:analysisBinding,director:directionBinding,frames,
      output_dir:outputDir,event_ids:[event.id],retrieval_contract_version:2});queued=await load(queue);
  }
  const repair={event_id:event.id,queue,repair_reasons:initial.repair_reasons,original_intent:query.text,
    status:'query_repair_pending',model_execution_attempted:false};
  const executeDir=path.join(outputDir,'execution'),resultFile=path.join(executeDir,'result.json');
  let returned=await existingJson(resultFile),result;
  if(returned){
    result=await bind(resultFile);
    await verifyEvidenceBindings([returned.request,returned.source,returned.analysis,returned.original_director,returned.raw_response]);
    if(returned.request.sha256!==queued.requests[0].sha256||returned.source.sha256!==source.sha256
      ||returned.analysis.sha256!==analysisBinding.sha256||returned.original_director.sha256!==directionBinding.sha256)
      throw Error('target_sfx_query_repair_binding_changed');
    repair.reused_bound_completion=true;
  }else{
    const marker=await existingJson(path.join(outputDir,'attempt-started.json'));
    if(marker){
      if(marker.request.sha256!==queued.requests[0].sha256||marker.source.sha256!==source.sha256)
        throw Error('target_sfx_query_repair_binding_changed');
      const failed=await existingJson(path.join(outputDir,'attempt-failure.json'));
      Object.assign(repair,{status:'query_repair_failed_or_pending',replay_prevented:true,
        error:failed?.error??'Submitted query repair has unknown outcome; reconcile its original return before retry.'});
      return {query,projected:initial,repair};
    }
    if(!session||!['runRole','request','director'].some(key=>typeof session[key]==='function'))return {query,projected:initial,repair};
    const started=await saveJson(path.join(outputDir,'attempt-started.json'),{request:queued.requests[0],source,
      started_at:new Date().toISOString(),status:'submitted_outcome_pending',qualification_granted:false});
    repair.model_execution_attempted=true;repair.attempt_started=started;
    try{
      result=await completeSoundQueryRequest({request:queued.requests[0],source,output_dir:executeDir},session);
    }catch(error){
      await saveJson(path.join(outputDir,'attempt-failure.json'),{attempt_started:started,error:error.message,
        cli_receipts:error.cli_receipts??[],status:'failed_or_outcome_unknown',qualification_granted:false});
      if(/binding_changed|source_mismatch|scope_mismatch/.test(error.message??''))throw error;
      Object.assign(repair,{error:error.message,status:'query_repair_failed_or_pending'});return {query,projected:initial,repair};
    }
  }
  const handoffFile=path.join(outputDir,'merged/handoff.json');
  const existing=await existingJson(handoffFile);
  const merged=existing?await bind(handoffFile):await mergeSoundQueryCompletions({queue,results:[result],output_dir:path.join(outputDir,'merged')});
  const handoff=await load(merged);
  if(handoff.completion_queue.sha256!==queue.sha256||!same(handoff.completion_results,[result]))
    throw Error('target_sfx_query_repair_binding_changed');
  const derived=await load(handoff.derived_director),next=derived.sound_queries.find(row=>row.event_id===event.id);
  const projected=normalizeSoundRetrievalQuery(next,event);
  if(next?.text!==query.text||next?.asset_kind!==query.asset_kind||!projected.ready)throw Error('target_sfx_query_repair_scope_mismatch');
  Object.assign(repair,{status:'query_projection_completed_materials_still_pending',result,merged,derived_director:handoff.derived_director});
  return {query:next,projected,repair};
}

// Independent music and SFX are separate frozen supplies. An explicitly
// configured mixed asset database is allowed, but music publication alone is
// never inferred to contain an eligible SFX pack.
async function loadFrozenSoundLibrary(supplied, label) {
  if (!supplied) return null;
  const binding = supplied.library ?? (supplied.db ? { path: path.resolve(supplied.db), sha256: supplied.sha256 } : supplied);
  if (!path.isAbsolute(binding?.path ?? '') || !/^[a-f0-9]{64}$/.test(binding?.sha256 ?? ''))
    throw Error(`target_${label}_frozen_library_binding_required`);
  await verifyEvidenceBindings(binding);
  if (supplied.publication) {
    const publication = await load(supplied.publication);
    if (publication.library?.sha256 !== binding.sha256 || path.resolve(publication.library?.path ?? '') !== binding.path)
      throw Error(`target_${label}_frozen_publication_library_mismatch`);
  }
  return binding;
}

export async function loadTargetSfxLibrary(config, fallback = null) {
  return config.sfx_library ? loadFrozenSoundLibrary(config.sfx_library, 'sfx')
    : config.material_strategy === 'independent_music_packs' ? null : fallback;
}
export async function loadTargetAmbientLibrary(config) {
  return loadFrozenSoundLibrary(config.ambient_library, 'ambient');
}

export async function prepareTargetSfxMaterials(input) {
  const semanticConfig=input.config?.sfx_library?.semantic_retriever;
  if(semanticConfig&&typeof input.runtime?.sfxSemanticRetriever!=='function'){
    const semantic=await createSfxClapRetriever(semanticConfig,{libraryBinding:input.libraryBinding});
    try{return await prepareTargetSfxMaterials({...input,runtime:{...input.runtime,
      sfxSemanticRetriever:(query,directory)=>semantic.retrieve(query,directory)}});}
    finally{semantic.close();}
  }
  assemblySfxAdoptionEnabled(input.config);
  const observedAssemblyPool=observedAssemblySfxPoolEnabled(input.config);
  const catalogRoutingRevision=input.runtime?.soundCatalogRoutingRevision??input.config?.codex_cli?.sound_catalog_routing_revision;
  if(catalogRoutingRevision!==undefined){
    const {prepareBoundSoundCatalogRouting}=await import('./sound_catalog_routing.mjs');
    const routing=await prepareBoundSoundCatalogRouting({analysisBinding:input.analysisBinding,
      directionBinding:input.directionBinding,source:input.source,outputDir:path.join(input.outputDir,'catalog-routing'),
      revision:catalogRoutingRevision});
    input={...input,directionBinding:routing.derived_director,catalogRoutingBinding:routing.artifact};
  }
  const queryRepairContract=input.runtime?.soundQueryRepairContract??input.config?.codex_cli?.sound_query_repair_contract??null;
  if(queryRepairContract!==null&&queryRepairContract!==soundQueryFieldProjectionRevision)
    throw Error('target_sfx_query_repair_contract_invalid');
  if(queryRepairContract){
    const previousDirectory=input.runtime?.soundQueryRepairPreviousDirectories?.[input.source?.sha256]
      ??path.join(input.outputDir,'query-repair');
    if(!path.isAbsolute(previousDirectory))throw Error('target_sfx_query_repair_previous_directory_required');
    const queryRepairBatch=await repairTargetSoundQueryBatch({analysisBinding:input.analysisBinding,directionBinding:input.directionBinding,
      source:input.source,frames:input.frames,libraryBinding:input.libraryBinding,python:input.config.python??'python',session:input.session,
      outputDir:path.join(input.outputDir,'query-repair-fields-v1'),legacyRepairDirectory:previousDirectory,
      ...(semanticConfig?.kind==='resident_sfx_clap'?{semanticRetrievalMode:'resident_sfx_clap'}:{}),
      sameJobCompletedMaterialRecovery:input.runtime?.sameJobCompletedMaterialRecovery,runtime:input.runtime,
      ...(observedAssemblyPool?{assemblyCandidatePoolContract:assemblySfxCandidatePoolRevision}:{}),
      completedRecovery:input.runtime?.completedSoundQueryRepairRecoveries?.[input.source?.sha256]});
    input={...input,queryRepairBatch,queryRepairContract,
      directionBinding:queryRepairBatch.derived_director??input.directionBinding};
  }
  const sfx = await prepareTargetSoundGroup(input);
  if (!input.config.ambient_library) return sfx;
  const ambientLibrary = await loadTargetAmbientLibrary(input.config);
  const ambient = await prepareTargetSoundGroup({ ...input, libraryBinding: ambientLibrary,
    assetKind: 'ambience', outputDir: path.join(input.outputDir, 'ambient') });
  const eventDecisions = new Map(sfx.event_decisions.map(row => [row.event_id, row]));
  for (const row of ambient.event_decisions) if (row.role === 'ambience') eventDecisions.set(row.event_id, row);
  const bound = await Promise.all([sfx.current_materials, ambient.current_materials].filter(Boolean).map(load));
  const currentMaterials = bound.length ? await saveJson(path.join(input.outputDir, 'combined-sound-materials.json'), {
    ...bound[0], cases: bound.flatMap(row => row.cases ?? []), sound_packs: bound.flatMap(row => row.sound_packs ?? []),
    sfx_library: input.libraryBinding, ambient_library: ambientLibrary,
    material_preparations: [sfx.artifact, ambient.artifact], production_approval: false }) : null;
  const ambientIds = new Set(ambient.event_decisions.filter(row => row.role === 'ambience').map(row => row.event_id));
  const gaps = [...sfx.gaps.filter(row => !ambientIds.has(row.event_id)),
    ...ambient.gaps.filter(row => ambientIds.has(row.event_id))];
  const combined = { ...sfx, status: gaps.length ? 'target_sfx_prepared_with_local_gaps' : 'target_sfx_prepared', gaps,
    ...(currentMaterials ? { current_materials: currentMaterials } : {}), ambient_library: ambientLibrary,
    material_preparations: [sfx.artifact, ambient.artifact], event_decisions: [...eventDecisions.values()],
    sounds: [...sfx.sounds, ...ambient.sounds], selected_count: sfx.selected_count + ambient.selected_count,
    actual_asset_selection_performed: sfx.actual_asset_selection_performed || ambient.actual_asset_selection_performed };
  if(sfx.adoption_pending||ambient.adoption_pending)Object.assign(combined,{adoption_pending:true,
    sound_pool_count:(sfx.sound_pool_count??0)+(ambient.sound_pool_count??0),actual_sound_adoption_performed:false});
  delete combined.artifact;
  combined.artifact = await saveJson(path.join(input.outputDir, 'combined-target-sounds.json'), combined);
  return combined;
}

// Reuse the corpus query/observer/selector/binder. The research episode scope keeps
// physical, Foley and ambience on the original track; it never infers missing source sounds.
async function prepareTargetSoundGroup({ config, analysisBinding, directionBinding, currentCaseBinding,
  source, manifestBinding, libraryBinding, evidenceCatalogBinding, frames = [], session, runtime = {}, outputDir,
  assetKind = 'sfx',queryRepairContract=null,queryRepairBatch=null,catalogRoutingBinding=null }) {
  if (config?.mode !== 'research' || config.automatic_trial !== true || !path.isAbsolute(outputDir ?? ''))
    throw Error('target_sfx_explicit_automatic_research_required');
  const diagnosticAnchors = config.trial_review_policy === 'diagnostic_candidates';
  const observedAssemblyPool=observedAssemblySfxPoolEnabled(config)&&assetKind==='sfx';
  const eventFunctionRevision=runtime.sfxEventFunctionRevision??config.codex_cli?.sfx_event_function_revision;
  if(eventFunctionRevision!==undefined&&eventFunctionRevision!==sfxEventFunctionRevision)
    throw Error('sfx_event_function_revision_invalid');
  if(eventFunctionRevision&&!(runtime.sfxMaterialSelectionProjection??config.codex_cli?.sfx_material_selection_projection))
    throw Error('sfx_event_function_selection_projection_required');
  if(observedAssemblyPool&&eventFunctionRevision!==sfxEventFunctionRevision)
    throw Error('assembly_sfx_observed_pool_function_revision_required');
  // Music-only frozen observers need not contain SFX. Preserve the separate
  // technical SFX protocol and evidence instead of relabelling either backend.
  if(typeof runtime.sfxMaterialObserver==='function')runtime={...runtime,
    materialObserver:runtime.sfxMaterialObserver,
    materialObserverBatch:runtime.sfxMaterialObserverBatch,
    materialObserver_backend_id:runtime.sfxMaterialObserver_backend_id??null,
    materialObserver_model_revision:runtime.sfxMaterialObserver_model_revision??null};
  const diagnosticPolicy=diagnosticAnchors?await validateIndependentMusicPackPolicy(config, {
    outputDirectory: outputDir, operation: 'prepare_independent_music_materials' }):null;
  if (diagnosticAnchors && !isIndependentMusicPackTrial(config)) throw Error('independent_music_pack_trial_scope_required');
  await mkdir(outputDir, { recursive: true });
  await verifyEvidenceBindings([analysisBinding, directionBinding, currentCaseBinding, source, manifestBinding, libraryBinding, evidenceCatalogBinding, frames]);
  const analysis = await load(analysisBinding), encodedDirection = await load(directionBinding);
  const director = encodedDirection.direction ?? encodedDirection, parent = await load(currentCaseBinding), manifest = await load(manifestBinding);
  if (analysis.source_video_sha256 !== source.sha256 || director.source_video_sha256 !== source.sha256
    || manifest.source_sha256 !== source.sha256 || manifest.timeline?.sample_rate !== 48000)
    throw Error('target_sfx_current_source_or_clock_mismatch');
  const duration = manifest.timeline.duration_samples / 48000, events = analysis.sound_events ?? [], ids = new Set();
  const observationIds = new Set(parent.cases.flatMap(item => item.evidence?.observation_ids ?? []));
  if (evidenceCatalogBinding) {
    const catalog = await load(evidenceCatalogBinding);
    if (catalog.source_video_sha256 !== source.sha256) throw Error('target_sfx_current_evidence_catalog_changed');
    for (const row of catalog.evidence ?? []) observationIds.add(row.id);
  }
  for (const event of events) {
    if (!text(event.id) || ids.has(event.id) || !['physical', 'foley', 'ambience', 'dramatic', 'transition'].includes(event.role)
      || !inside([event.start_seconds, event.end_seconds], [0, duration]) || !text(event.reason)
      || !event.evidence_ids?.length) throw Error('target_sfx_actual_bound_event_required');
    ids.add(event.id);
  }
  const base = path.dirname(manifestBinding.path);
  const original = text(manifest.original_audio) ? { path: path.resolve(base, manifest.original_audio),
    sha256: await hashFile(path.resolve(base, manifest.original_audio)) } : null;
  const record = { schema_version: 1, source_video_sha256: source.sha256, source, original_audio: original,
    manifest: manifestBinding, analysis: analysisBinding, direction: directionBinding, library: libraryBinding, asset_kind: assetKind,
    original_sound_facts: 'not_qualified_by_story_or_vad', event_decisions: [], gaps: [], sounds: [],
    selected_count: 0, actual_asset_selection_performed: false, Ready: false, qualified: false,
    artistic_approval: false, production_approval: false, render_calls: 0, generation_calls: 0 };
  if(catalogRoutingBinding){await verifyEvidenceBindings(catalogRoutingBinding);record.catalog_routing=catalogRoutingBinding;}
  if(queryRepairBatch)Object.assign(record,{query_repair_contract:queryRepairContract,query_repair_batch:queryRepairBatch,
    original_direction:queryRepairBatch.original_director});
  const finish = async () => { record.status = record.gaps.length ? 'target_sfx_prepared_with_local_gaps' : 'target_sfx_prepared';
    record.artifact = await saveJson(path.join(outputDir, 'target-sfx-materials.json'), record); return record; };
  const cases = [], tasks = [], byCase = new Map(), fixed = new Map(), originalReviews = new Map(),projections=new Map(),shortBeds=new Set();
  for (const event of events) {
    const ambient = assetKind === 'ambience' && event.role === 'ambience';
    if (ambient && original) {
      const review = await findOriginalSoundEventReview(config.original_sound_reviews, {
        source, original, manifest: manifestBinding, event });
      if (review) originalReviews.set(event.id, review);
    }
    if (config.trial_scope?.kind === 'music_only_episode' || assetKind === 'ambience' && !ambient
      || ['physical', 'foley', 'ambience'].includes(event.role) && !originalReviews.has(event.id)) {
      const reason = config.trial_scope?.kind === 'music_only_episode'
        ? 'The requested music-only scope preserves the complete original sound track.'
        : `Preserve the original track: ${event.role} presence, absence and insufficiency are unknown; picture and ASR/VAD do not qualify them.`;
      fixed.set(event.id, omission(event, reason));
      if (event.decision === 'seek_asset' && config.trial_scope?.kind !== 'music_only_episode')
        record.gaps.push({ event_id: event.id, role: event.role, target_range: [event.start_seconds, event.end_seconds],
          gap: 'original_sound_fact_review_required_before_physical_or_ambience_addition', blocks_render: false });
      continue;
    }
    let query = director.sound_queries?.find(row => row.event_id === event.id);
    let queryDirectorBinding=directionBinding;
    if (!query) {
      fixed.set(event.id, omission(event, 'No current director query authorizes an optional new sound; preserve the original track.'));
      if (event.decision === 'seek_asset') record.gaps.push({ event_id: event.id, role: event.role,
        gap: 'current_sound_query_pending', target_range: [event.start_seconds, event.end_seconds], blocks_render: false });
      continue;
    }
    if (!text(query.text) || query.asset_kind !== assetKind) throw Error('target_sfx_actual_event_query_kind_required');
    let projected=normalizeSoundRetrievalQuery(query,event);
    if(!projected.ready){
      const repairDir=path.join(outputDir,'query-repair',encodeURIComponent(event.id));
      const repaired=queryRepairContract?{query,projected,repair:{event_id:event.id,
        queue:queryRepairBatch.queue??null,status:queryRepairBatch.status,model_execution_attempted:false,
        repair_reasons:projected.repair_reasons,batch_artifact:queryRepairBatch.artifact}}
        :await repairTargetSoundQuery({query,event,analysisBinding,directionBinding,source,frames,session,outputDir:repairDir});
      query=repaired.query;projected=repaired.projected;
      if(repaired.repair.derived_director)queryDirectorBinding=repaired.repair.derived_director;
      record.query_repairs??=[];record.query_repairs.push(repaired.repair);
      if(!projected.ready){
        fixed.set(event.id,omission(event,'The query requires an explicit positive projection and separate exclusions; preserve the original intent and track.','query_repair_required'));
        record.gaps.push({event_id:event.id,role:event.role,gap:'query_repair_required',repair_queue:repaired.repair.queue,
          repair_reasons:projected.repair_reasons,target_range:[event.start_seconds,event.end_seconds],blocks_render:false});
        continue;
      }
    }
    projected=await resolveSoundCatalogFunction({projected,query,libraryBinding,
      directorBinding:queryDirectorBinding,python:config.python??'python'});
    if(projected.catalog_function_resolution){
      record.catalog_function_resolutions??=[];
      record.catalog_function_resolutions.push({event_id:event.id,...projected.catalog_function_resolution});
    }
    projected=await resolveSfxSemanticCandidates({projected,query,libraryBinding,directorBinding:queryDirectorBinding,
      retrieve:runtime.sfxSemanticRetriever,outputDir:path.join(outputDir,'semantic-recall',encodeURIComponent(event.id))});
    if(projected.sound_semantic_recall){
      record.semantic_recalls??=[];
      record.semantic_recalls.push({event_id:event.id,...projected.sound_semantic_recall});
    }
    if(!projected.sound_semantic_recall?.candidate_count)
      projected=await resolveSoundCatalogueLexicalAliases({projected,query,libraryBinding,
        directorBinding:queryDirectorBinding,python:config.python??'python'});
    if(projected.catalogue_lexical_aliases){
      record.catalogue_query_aliases??=[];
      record.catalogue_query_aliases.push({event_id:event.id,...projected.catalogue_lexical_aliases});
    }
    const parents = parent.cases.filter(item => item.evidence?.source_video_sha256 === source.sha256
      && overlap(item.source_range, [event.start_seconds, event.end_seconds]));
    if (!parents.length || event.evidence_ids.some(id => !observationIds.has(id)))
      throw Error('target_sfx_event_outside_current_bound_story');
    const caseId = `current-target/${source.sha256}/sound/${encodeURIComponent(event.id)}`, stepId = event.id + '/sound';
    const item = { ...structuredClone(parents[0]), case_id: caseId, source_range: [event.start_seconds, event.end_seconds],
      source_role: 'current_unscored_target_not_reference_success_case', description: event.reason,
      music_pack_ids: [], sound_pack_ids: [], theme_bundle_ids: [],
      evidence: { source_video_sha256: source.sha256, source_range: [event.start_seconds, event.end_seconds],
        observation_ids: event.evidence_ids, files: [analysisBinding, directionBinding, manifestBinding, currentCaseBinding, original,
          ...(originalReviews.has(event.id) ? [originalReviews.get(event.id).binding] : []),
          ...(evidenceCatalogBinding ? [evidenceCatalogBinding] : [])],
        actual_audio_processed: false, artistic_approval: false, evidence_status: 'current_sound_intention_original_presence_unknown' },
      source_events: [{ event_id: event.id, kind: 'sound', source_range: [event.start_seconds, event.end_seconds],
        observation_ids: event.evidence_ids, description: event.reason }],
      development_preset: { steps: [{ step_id: stepId, source_event_id: event.id, action: 'compare_' + event.role,
        anchor: event.id, target_range: [event.start_seconds, event.end_seconds], music_pack_ids: [], sound_pack_ids: [], window_refs: [] }] } };
    cases.push(item); byCase.set(caseId, event);projections.set(event.id,projected);
    tasks.push({ case_id: caseId, step_id: stepId, source_event_id: event.id, sound_role: event.role,
      reason: query.text, query: projected.retrieval,
      sound_query_projection:{original_intent:projected.original_intent,retrieval_query:projected.retrieval.text,
        excluded_tags:projected.retrieval.excluded_tags,duration_role:projected.duration_role,
        basis:projected.projection_basis,
        ...(projected.catalog_function_resolution?{catalog_function_resolution:projected.catalog_function_resolution}:{}),
        ...(projected.catalogue_lexical_aliases?{catalogue_lexical_aliases:projected.catalogue_lexical_aliases}:{}),
        ...(projected.sound_semantic_recall?{sound_semantic_recall:projected.sound_semantic_recall}:{}),
        ...(observedAssemblyPool?{exclusion_intent_context:queryRepairBatch?.exclusion_intent_context?.queries.find(row=>row.event_id===event.id)
          ??{excluded_tags:[...projected.retrieval.excluded_tags],original_intent:query.text,
            metadata_exclusion_does_not_verify_sound_or_safety:true,narrative_conflicts_still_require_observed_assembly_comparison:true,
            qualification_granted:false}}:{}),
        qualification_granted:false},
      ...(eventFunctionRevision?{sound_function_intent:soundEventFunctionIntent({event,projected,query})}:{}),
      evidence_files: [analysisBinding, directionBinding] });
  }
  if (!tasks.length) { record.event_decisions = events.map(event => fixed.get(event.id)); return finish(); }
  if (!original) {
    for (const event of byCase.values()) {
      fixed.set(event.id, omission(event, 'Prepared original audio is unavailable; keep the original track.'));
      record.gaps.push({ event_id: event.id, role: event.role, gap: 'target_sfx_prepared_original_audio_required', blocks_render: false });
    }
    record.event_decisions = events.map(event => fixed.get(event.id)); return finish();
  }
  if (!libraryBinding) {
    for (const event of byCase.values()) {
      fixed.set(event.id, omission(event, 'A separately frozen SFX library is missing; keep the original track.',
        'frozen_sfx_library_binding_required'));
      record.gaps.push({ event_id: event.id, role: event.role, gap: 'frozen_sfx_library_binding_required', blocks_render: false });
    }
    record.event_decisions = events.map(event => fixed.get(event.id)); return finish();
  }
  if (typeof runtime.materialObserver !== 'function' || !observedAssemblyPool&&typeof runtime.materialSelector !== 'function') {
    for (const event of byCase.values()) {
      fixed.set(event.id, omission(event, 'Actual sound observation/selection runtime is unavailable; preserve the original track.'));
      record.gaps.push({ event_id: event.id, role: event.role, gap: 'actual_sfx_observer_or_selector_required', blocks_render: false });
    }
    record.event_decisions = events.map(event => fixed.get(event.id)); return finish();
  }
  const document = { ...parent, cases, packs: [], sound_packs: [], theme_bundles: [], production_approval: false };
  const recoveryBinding = runtime.completedSfxMaterialSelectionRecoveries?.[source.sha256]?.[assetKind];
  const recovery = recoveryBinding ? await loadCompletedTargetSfxSelection(recoveryBinding,
    { source, libraryBinding, assetKind, document, tasks, currentCaseBinding }) : null;
  let caseInput, candidateFile, candidates, selected, selectionRef;
  if (recovery) {
    ({ caseInput, candidates, selectionRef } = recovery); candidateFile = recovery.candidateBinding.path; selected = recovery.record;
    record.completed_selection_recovery = recovery.proof;
  } else {
  caseInput = await saveJson(path.join(outputDir, 'current-sound-case-input.json'), document);
  const taskInput = await saveJson(path.join(outputDir, 'tasks.json'), { schema_version: 1, tasks });
  candidateFile = path.join(outputDir, 'candidates.json');
  await run(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'corpus_materials.py'), '--input', caseInput.path,
    '--candidate-tasks', taskInput.path, '--library-db', libraryBinding.path, '--candidate-report', path.join(outputDir, 'recall.json'),
    '--output', candidateFile], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  candidates = expandCandidateEvidence(await readJson(candidateFile));
  if(observedAssemblyPool){
    const prepared=await prepareObservedAssemblySfxPool({config,source,analysis:analysisBinding,direction:directionBinding,
      manifest:manifestBinding,library:libraryBinding,caseInput,candidateFile,events,outputDir:path.join(outputDir,'observed-assembly-pool'),runtime,
      observationOptions:{sfx_material_selection_projection:runtime.sfxMaterialSelectionProjection??config.codex_cli.sfx_material_selection_projection,
        completed_target_story:analysisBinding,sfx_diagnostic_policy:diagnosticPolicy,sfx_event_function_revision:eventFunctionRevision}});
    Object.assign(record,prepared,{candidates:await bind(candidateFile),current_case:caseInput,
      adoption_pending:prepared.sounds.length>0,sound_pool_count:prepared.sounds.length,actual_sound_adoption_performed:false,
      selected_count:0,actual_asset_selection_performed:false,gaps:[...record.gaps,...prepared.gaps]});
    for(const event of byCase.values())if(!prepared.sounds.some(row=>row.event_id===event.id)){
      fixed.set(event.id,omission(event,'No actually observed candidate with a scoped anchor is available; preserve the original track.'));
      record.gaps.push({event_id:event.id,role:event.role,target_range:[event.start_seconds,event.end_seconds],
        gap:'observed_assembly_sfx_candidate_unavailable',blocks_render:false});
    }
    record.event_decisions=events.map(event=>fixed.get(event.id)??{event_id:event.id,role:event.role,decision:'pending_assembly_adoption',
      original_status:'unknown',preserve_original_track:true,selected_segment_id:null,selected_source_range:null,source_anchor_seconds:null,
      reason:'Actually observed, unselected frozen candidates await the real final assembly comparison.'});
    return finish();
  }
  selected = await selectMaterials({ candidate_file: candidateFile, input_file: caseInput.path,
    output_dir: path.join(outputDir, 'selection'),
    ...(runtime.sfxMaterialSelectionProjection??config.codex_cli?.sfx_material_selection_projection
      ?{sfx_material_selection_projection:runtime.sfxMaterialSelectionProjection??config.codex_cli.sfx_material_selection_projection,
        completed_target_story:analysisBinding,
        ...(eventFunctionRevision?{sfx_event_function_revision:eventFunctionRevision}:{}),
        ...(diagnosticPolicy&&assetKind==='sfx'
          &&(runtime.sfxMaterialSelectionProjection??config.codex_cli.sfx_material_selection_projection)===sfxMaterialSelectionProjectionRevision
          &&tasks.every(task=>['dramatic','transition'].includes(task.sound_role))
          ?{sfx_diagnostic_policy:diagnosticPolicy}:{})}: {}) }, runtime);
  selectionRef = await bind(path.join(outputDir, 'selection/selection-record.json'));
  }
  record.selection = selectionRef; record.current_case = caseInput; record.candidates = await bind(candidateFile);
  const pool = [];
  if (selected.bindings_file) {
    record.selected_bindings = selected.bindings_file;
    const mappings = await load(selected.bindings_file), boundFile = path.join(outputDir, 'current-sound-materials.json');
    await run(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'corpus_materials.py'), '--input', caseInput.path,
      '--bindings', selected.bindings_file.path, '--library-db', libraryBinding.path, '--output', boundFile],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    record.current_materials = await bind(boundFile); record.actual_asset_selection_performed = selected.automatic_selection_performed === true;
    for (const mapping of mappings.bindings) for (const sound of mapping.sounds) {
      const event = byCase.get(mapping.case_id), sourceCandidate = candidates.tasks.find(task => task.case_id === mapping.case_id)
        ?.candidates.find(row => row.candidate.segment_id === sound.segment_id)?.candidate;
      const functionIntent=tasks.find(task=>task.case_id===mapping.case_id)?.sound_function_intent;
      const actualDecision=selected.raw_response?((await load(selected.raw_response)).value?.decisions??[])
        .find(row=>row.case_id===mapping.case_id&&row.step_id===sound.step_id):null;
      let functionGap=null;
      if(eventFunctionRevision){
        functionGap=validateSelectedSoundUsage(actualDecision,{sound_role:event.role,sound_function_intent:functionIntent,
          candidates:[{segment_id:sound.segment_id,source_range:sound.source_range}]});
        if(!same(sound.sound_usage,actualDecision.sound_usage)||!same(sound.sound_function_intent,functionIntent)
          ||!same(sound.selection_source_ranges,[actualDecision.sound_usage.usable_source_range]))
          throw Error('target_sfx_selected_function_binding_changed');
        if(functionGap){
          fixed.set(event.id,omission(event,'The actual selected function cannot satisfy the bound current event; preserve the original track.',functionGap.gap));
          record.gaps.push({event_id:event.id,role:event.role,target_range:[event.start_seconds,event.end_seconds],
            ...functionGap,sound_function_intent:functionIntent,sound_usage:actualDecision.sound_usage,blocks_render:false});
          continue;
        }
      }
      const usage=eventFunctionRevision?sound.sound_usage:null;
      const usableRange=usage?.usable_source_range??sound.source_range;
      const bed=usage?usage.function==='bed':projections.get(event.id)?.duration_role==='bed',requiredDuration=event.end_seconds-event.start_seconds;
      if(bed&&sound.source_range[1]-sound.source_range[0]+1/48000<requiredDuration){shortBeds.add(event.id);continue;}
      const humanRef = sourceCandidate?.record?.human_review_record;
      let human = null;
      if (humanRef) {
        try { human = await loadOfflineHumanReview(humanRef, { sourceSha: sound.source_sha256, sourceRange: sound.source_range }); }
        catch { /* Failed scoped facts remain a local anchor gap, never a guessed attack. */ }
      }
      const ambient = event.role === 'ambience';
      if (ambient && !diagnosticAnchors && human?.record.asset_kind !== 'ambience') continue;
      let anchor = human?.record.asset_kind === 'sfx' ? human.record.source_anchor_seconds : null, measured = null;
      if(bed&&!ambient){
        if(!diagnosticAnchors)continue;
        measured=await measureDiagnosticBedPlacement({source:{path:sourceCandidate.local_path,sha256:sound.source_sha256},
          sourceRange:usableRange,targetSource:source,event,outputDir:path.join(outputDir,'measured-bed-placement',
            shaBytes(mapping.case_id+':'+sound.segment_id).slice(0,20))});
        anchor=usableRange[0];
      }else if (!ambient && !Number.isFinite(anchor) && diagnosticAnchors) {
        measured = await (runtime.sfxAnchorMeasurer??measureDiagnosticSfxAnchor)({ source: { path: sourceCandidate.local_path, sha256: sound.source_sha256 },
          segmentId:sound.segment_id,
          sourceRange: usableRange, outputDir: path.join(outputDir, 'measured-anchors',
            shaBytes(mapping.case_id + ':' + sound.segment_id).slice(0, 20)) });
        const receipt = await load(measured); anchor = receipt.anchor_candidates[0]?.seconds;
      }
      if (!ambient && (!Number.isFinite(anchor) || anchor < usableRange[0] || anchor >= usableRange[1])) continue;
      const observationRef = sound.listening_evidence.observation_record ?? await saveJson(path.join(outputDir,
        `observation-${shaBytes(mapping.case_id + ':' + sound.segment_id).slice(0, 20)}.json`), {
        ...sound.listening_evidence, source_sha256: sound.source_sha256, source_range: sound.source_range,
        actual_audio_processed: true, actual_audio_listened: false, qualified: false, production_approval: false });
      pool.push({ ...sound, event_id: event.id, local_path: sourceCandidate.local_path,
        ...(eventFunctionRevision?{sound_function_intent:functionIntent,sound_usage:usage,
          selection_source_ranges:[usableRange],selector_adopt_reason:actualDecision.adopt_reason}:{}),
        duration_role:usage?usage.function==='point'?'transient':'bed':bed?'bed':'transient',
        required_duration_seconds:bed||usage?.function==='ambience'?requiredDuration:null,
        current_event_target_range:[event.start_seconds,event.end_seconds],current_target_video_sha256:source.sha256,
        target_case_id: mapping.case_id, target_step_id: sound.step_id, observation_record: observationRef,
        ...(ambient ? { original_sound_review: originalReviews.get(event.id).binding,
          original_status: originalReviews.get(event.id).record.original_status, anchor_review_status: 'ambient_bed_no_transient_anchor_required' }
          : { source_anchor_seconds: anchor, source_anchor_evidence: measured ?? human.binding }),
        ...(measured ? { anchor_review_status: 'measured_diagnostic_pending_audition',
          source_facts_scope:bed?'technical_window_start_not_transient_or_approved_scene_fit':'measured_candidate_not_approved_attack_or_scene_fit',
          production_approval: false, artistic_approval: false }
          : human ? { human_review_record: human.binding, source_facts_scope: 'existing_reviewed_source_window_not_current_scene_approval' }
            : { source_facts_scope: 'diagnostic_ambient_candidate_not_approved_scene_fit' }),
        clean_content_status: 'unknown' });
    }
  }
  for (const event of byCase.values()) if (!fixed.has(event.id)&&!pool.some(row => row.event_id === event.id)) {
    fixed.set(event.id, omission(event, 'No actual selected sound with a scoped source anchor is available; preserve the original track.'));
    record.gaps.push({ event_id: event.id, role: event.role, target_range: [event.start_seconds, event.end_seconds],
      gap: shortBeds.has(event.id)?'actual_selected_sound_bed_duration_insufficient':candidates.tasks.some(task => task.case_id && byCase.get(task.case_id)?.id === event.id && task.candidates.length)
        ? 'actual_selected_sfx_source_anchor_pending' : 'actual_sfx_retrieval_empty', blocks_render: false });
  }
  if(assemblySfxAdoptionEnabled(config)){
    record.sounds=await prepareAssemblySfxPool({pool,source,analysis:analysisBinding,direction:directionBinding,
      manifest:manifestBinding,library:libraryBinding,caseInput,selectionRef,selectorRaw:selected.raw_response,outputDir});
    record.event_decisions=events.map(event=>fixed.get(event.id)??{event_id:event.id,role:event.role,
      decision:'pending_assembly_adoption',original_status:'unknown',preserve_original_track:true,
      selected_segment_id:null,selected_source_range:null,source_anchor_seconds:null,
      reason:'Observed and selected source candidates await the actual final assembly decision.'});
    record.adoption_pending=pool.length>0;record.sound_pool_count=pool.length;
    record.actual_sound_adoption_performed=false;record.selected_count=0;
    return finish();
  }
  if (!pool.length || typeof session?.director !== 'function') {
    for (const event of byCase.values()) if (!fixed.has(event.id)) {
      fixed.set(event.id, omission(event, 'Actual independent sound adoption has not executed; preserve the original track.'));
      record.gaps.push({ event_id: event.id, role: event.role, gap: 'actual_sfx_adoption_session_required', blocks_render: false });
    }
    record.event_decisions = events.map(event => fixed.get(event.id)); return finish();
  }
  const input = { stage: 'current_target_sound_adoption', schema: targetSfxDecisionSchema, frames,
    prompt: 'Independently decide each current sound event after reading its picture/story and actual sound observations. '
      + 'Unknown original presence cannot authorize physical/Foley/ambience additions: preserve those fixed omissions. '
      + 'Ambient beds may be supplied only with hash-bound human original-event missing/insufficient facts; these approve no new recording or final fit. Ambient decisions use source_anchor_seconds:null. '
      + (diagnosticAnchors ? 'Supplied dramatic/transition candidates may carry reviewed or explicitly measured diagnostic source anchors. '
        + 'A measured anchor is not a heard transient or approved use; keep audition pending. '
        : 'Only supplied dramatic/transition candidates with an existing reviewed source anchor may be new_asset. ')
      + 'Choose at most one supplied candidate per event and an in-bounds window containing its unchanged anchor, or omit with reason. '
      + 'A duration_role bed must retain a real selected source window at least as long as its current event; file duration alone cannot approve a shortened adopted window. '
      + 'A diagnostic bed anchor is its unchanged technical source-window start, not a transient peak. Retain that start; its target placement is the actual event start. '
      + 'Select the bed source end for the exact current event duration; do not keep an entire long recording that extends beyond the event or locked video. '
      + 'You did not hear the PCM yourself; keep source duplication, cleanliness, fit and actual sync review pending. Never grant approval.',
    data: { source_video_sha256: source.sha256, source, original_audio: original, analysis, director,
      original_sound_status: 'unknown', fixed_omissions: [...fixed.values()], sound_candidates: pool,
      material_selection: selectionRef, current_case: caseInput } };
  record.adoption_request = await saveJson(path.join(outputDir, 'sound-adoption-request.json'), input);
  const response = await session.director(input); await verifyEvidenceBindings(response.raw_response);
  const raw = await readJson(response.raw_response.path);
  let rawValue = raw.value;
  if (rawValue === undefined && raw.status === 'completed') {
    const value = raw.output?.flatMap(row => row.content ?? []).filter(row => ['text', 'output_text'].includes(row.type)).map(row => row.text).join('');
    if (value) rawValue = JSON.parse(value);
  }
  if (!same(rawValue, response.value)) throw Error('target_sfx_actual_adoption_response_binding_required');
  const result = validateSchema(response.value, targetSfxDecisionSchema), seen = new Set();
  for (const decision of result.decisions) {
    const event = events.find(row => row.id === decision.event_id);
    if (!event || seen.has(event.id) || !text(decision.reason)) throw Error('target_sfx_exact_event_adoption_required');
    seen.add(event.id);
    if (decision.decision === 'omit') {
      if (decision.selected_segment_id !== null || decision.selected_source_range !== null || decision.source_anchor_seconds !== null)
        throw Error('target_sfx_omission_cannot_consume_asset');
      fixed.set(event.id, omission(event, decision.reason)); continue;
    }
    const candidate = pool.find(row => row.event_id === event.id && row.segment_id === decision.selected_segment_id);
    const ambient = event.role === 'ambience' && originalReviews.has(event.id);
    if (!candidate || fixed.has(event.id) || !(['dramatic', 'transition'].includes(event.role) || ambient)
      || !inside(decision.selected_source_range, candidate.source_range)
      ||candidate.sound_usage&&!inside(decision.selected_source_range,candidate.sound_usage.usable_source_range)
      || (ambient ? decision.source_anchor_seconds !== null
        : decision.source_anchor_seconds !== candidate.source_anchor_seconds
          || decision.source_anchor_seconds < decision.selected_source_range[0] || decision.source_anchor_seconds >= decision.selected_source_range[1]))
      throw Error('target_sfx_actual_scoped_candidate_and_anchor_required');
    if(candidate.duration_role==='bed'&&decision.selected_source_range[1]-decision.selected_source_range[0]+1/48000
      <candidate.required_duration_seconds)throw Error('target_sfx_bed_window_must_cover_event');
    if(candidate.duration_role==='bed'&&event.role!=='ambience'&&Math.abs(decision.selected_source_range[1]-decision.selected_source_range[0]
      -candidate.required_duration_seconds)>1/48000)throw Error('target_sfx_bed_window_must_match_event');
    const selection = await saveJson(path.join(outputDir, `current-selection-${encodeURIComponent(event.id)}.json`), {
      schema_version: 1, source_video_sha256: source.sha256, decisions: [{ event_id: event.id,
        selected_segment_id: candidate.segment_id, selected_source_range: decision.selected_source_range, reason: decision.reason }],
      sound_adoption_response: response.raw_response,
      selection_provenance: { selector_record: selectionRef, raw_response: selected.raw_response, case_input: caseInput } });
    let placement=candidate.source_anchor_evidence;
    if(candidate.duration_role==='bed'&&event.role!=='ambience'&&!same(decision.selected_source_range,candidate.source_range)){
      placement=await measureDiagnosticBedPlacement({source:{path:candidate.local_path,sha256:candidate.source_sha256},
        sourceRange:decision.selected_source_range,targetSource:source,event,
        outputDir:path.join(outputDir,'adopted-bed-placement',encodeURIComponent(event.id))});
    }
    record.sounds.push({ ...candidate, source_range: decision.selected_source_range,
      ...(candidate.sound_usage?{actual_adoption_response:response.raw_response}:{}),...(placement?{source_anchor_evidence:placement}:{}),
      selection_source_ranges: [decision.selected_source_range], selection_record: selection });
    fixed.set(event.id, { event_id: event.id, role: event.role, decision: 'new_asset', original_status: candidate.original_status ?? 'unknown',
      preserve_original_track: true, selected_segment_id: candidate.segment_id,
      selected_source_range: decision.selected_source_range, source_anchor_seconds: decision.source_anchor_seconds,
      ...(ambient ? { original_sound_review: candidate.original_sound_review } : {}),
      reason: decision.reason, actual_adoption_response: response.raw_response, artistic_approval: false });
  }
  if (seen.size !== events.length) throw Error('target_sfx_adoption_missing_current_events');
  await verifyEvidenceBindings([libraryBinding, source, original, selected.raw_response, response.raw_response]);
  record.event_decisions = events.map(event => fixed.get(event.id)); record.selected_count = record.sounds.length;
  record.review_pending = result.review_pending; record.adoption_response = response.raw_response;
  return finish();
}
