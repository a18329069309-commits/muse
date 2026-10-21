import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readJson, saveJson, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { compileSoundArcPlan } from './sound_arc_plan.mjs';
import { isIndependentMusicPackTrial, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { verifyCompletedMaterialSelection } from './completed_material_selection_evidence.mjs';
import { auditMusicActionExecution } from './music_action_execution_audit.mjs';

export const constraintEditorRevision = 'constraint_editor_diagnostic_v1';
const moduleFile = fileURLToPath(import.meta.url), RATE = 48000;
const actionAuditModuleFile = fileURLToPath(new URL('./music_action_execution_audit.mjs', import.meta.url));
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a,b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('constraint_editor_' + reason); };
const sample = value => Math.round(value * RATE), seconds = value => value / RATE;
const valid = row => Array.isArray(row) && row.length === 2 && row.every(Number.isFinite) && row[0] >= 0 && sample(row[1]) > sample(row[0]);
const inside = (inner, outer) => valid(inner) && valid(outer) && sample(inner[0]) >= sample(outer[0]) && sample(inner[1]) <= sample(outer[1]);
const text = value => typeof value === 'string' && value.trim();
const parameters = Object.freeze({ crossfade_each_side_samples: 12000, outer_fade_samples: 3840,
  target_window_proxy_dbfs: -23, maximum_music_gain_correction_db: 6, dialogue_ducking_db: 4,
  adopted_window_peak_ceiling_dbfs: -6.1,
  sound_gain_db: -12, source_choice: 'unique_actual_selected_window_only', implicit_loops: false });
const inputKeys = ['manifest','analysis','director','evidence_catalog','candidates','current_materials','case_routes','music_source_provenance'];

export function constraintEditorEnabled(config) {
  if (config.editor_strategy === undefined) return false;
  if (config.editor_strategy !== constraintEditorRevision || !isIndependentMusicPackTrial(config)) fail('explicit_independent_diagnostic_policy_required');
  return true;
}

export function constraintEditorDirection(values) {
  const director = structuredClone(values.director), deferred = [];
  for (const cue of director.cues ?? []) if (cue.words_candidate_request === 'explore' && cue.words_target_range != null
    && !(values.candidates.words ?? []).some(row => row.cue_id === cue.cue_id + '/words')) {
    if (!cue.words_opportunity?.allowed_target_intervals?.some(row => same(row, cue.words_target_range)))
      fail('exploration_placement_requires_original_permission_interval');
    deferred.push({ cue_id: cue.cue_id, request: 'explore', original_permitted_range: [...cue.words_target_range],
      opportunity: structuredClone(cue.words_opportunity), selected_complete_phrase: null,
      reason: 'A permission interval is not an adopted phrase placement; original actual exploration remains pending.',
      production_approval: false });
    cue.words_target_range = null;
  }
  return { director, deferred };
}

export function constraintEditorExplorationEvidence(deferred, verifiedSelections) {
  return deferred.map(row => {
    const id = row.cue_id + '/words', matches = verifiedSelections.flatMap(verified => {
      const task = verified.request.tasks.find(item => item.kind === 'words' && item.cue_id === id);
      const decision = verified.raw.value.decisions.find(item => item.kind === 'words' && item.cue_id === id);
      return task && decision ? [{ task, decision }] : [];
    });
    if (matches.length !== 1) fail('exploration_actual_comparison_required');
    const { task, decision } = matches[0];
    for (const id of decision.selected_segment_ids) {
      const candidate = task.candidates.find(item => item.segment_id === id);
      if (!candidate || candidate.phrase_boundaries_verified !== false || candidate.lyrics_state !== 'pending'
        || candidate.evidence_status !== 'unqualified_diagnostic_window_prediction')
        fail('exploration_cannot_hide_selected_complete_phrase');
    }
    return { cue_id: row.cue_id, actual_selected_segment_ids: [...decision.selected_segment_ids],
      actual_decision: structuredClone(decision),
      disposition: decision.selected_segment_ids.length ? 'selected_diagnostic_candidate_remains_pending' : 'actual_comparison_rejected_candidates' };
  });
}

/** Pure clock/source editing. All dramatic choices remain the bound director
 * and actual selector's; this function cannot retrieve or choose another song. */
export function compileConstraintEpisode(values) {
  const {manifest, analysis, candidates} = values;
  const {director, deferred} = constraintEditorDirection(values);
  const source = manifest.source_sha256, N = manifest.timeline?.duration_samples;
  if (manifest.timeline?.sample_rate !== RATE || !Number.isSafeInteger(N) || N <= 0
    || analysis.source_video_sha256 !== source || director.source_video_sha256 !== source) fail('source_clock_required');
  const arcs = [], music = [], actions = [], sounds = [], gaps = [];
  const pending = [
    'Deterministic diagnostic timing only: actual phrase, dramatic impact, dialogue masking and seams require listening. No professional approval.',
    'Gain intention uses the whole-window RMS proxy; actual adopted PCM windows including crossfade handles impose a conservative peak ceiling. This is technical headroom, not loudness or listening approval. Local dialogue attenuation remains active.',
    ...(analysis.uncertainties ?? []).map(row => `Original analysis uncertainty: ${row}`),
    ...(director.uncertainties ?? []).map(row => `Original direction uncertainty: ${row}`),
    ...(director.uncertainty_dispositions ?? []).flatMap(row => row.components.flatMap(part =>
      (part.retained_constraints ?? []).map(item => `Retained ${row.origin}/${row.uncertainty_index}: ${item}`))),
    ...(values.editor_selection_pending ?? []),
    ...deferred.map(row => `${row.cue_id} permitted lyric interval ${JSON.stringify(row.original_permitted_range)} retained, no complete phrase adopted: ${row.reason}`) ];
  const selected = [], cues = director.cues ?? [];
  if (!cues.length) fail('ordered_cues_required');
  let clock = 0;
  for (const cue of cues) {
    if (!valid(cue.target_range) || sample(cue.target_range[0]) !== clock) fail('exact_ordered_cue_clock_required');
    clock = sample(cue.target_range[1]);
    const matches = (candidates.music ?? []).filter(row => row.cue_id === cue.cue_id);
    if (matches.length !== 1) { gaps.push(`${cue.cue_id}: exactly one actual selected music window required, found ${matches.length}.`); selected.push(null); continue; }
    const candidate = matches[0];
    if (!valid(candidate.source_range) || !inside(cue.target_range, candidate.allowed_target_range ?? cue.target_range))
      fail('selected_window_or_target_changed');
    selected.push(candidate);
    if (cue.words_candidate_request === 'require' || cue.words_target_range != null)
      gaps.push(`${cue.cue_id}: required/fixed lyric placement needs a verified complete phrase and explicit adopted interval; this constraint editor does not invent it.`);
    else if (cue.words_candidate_request === 'explore') pending.push(`${cue.cue_id}: actual words exploration remains pending; unverified diagnostic vocal candidates are not automatically layered or declared complete phrases.`);
  }
  if (clock !== N) fail('whole_episode_clock_required');
  if (!gaps.length) for (let i = 0; i < cues.length; i++) {
    const cue = cues[i], candidate = selected[i], duration = sample(cue.target_range[1]) - sample(cue.target_range[0]);
    const previous = arcs.at(-1)?.pieces.at(-1), priorCandidate = selected[i - 1];
    const sameRecording = previous && candidate.source_sha256 === priorCandidate.source_sha256;
    if (previous && !sameRecording) {
      const left = values.editor_vocals?.[priorCandidate.observation_record?.sha256] ?? 'unknown';
      const right = values.editor_vocals?.[candidate.observation_record?.sha256] ?? 'unknown';
      if (left !== 'none' && right !== 'none' && (!values.editor_unverified_short_seam_authorized || left === 'sung' && right === 'sung')) {
        gaps.push(`${cue.cue_id}: overlapping two possible word voices is not approved; no automatic vocal waiver.`); break;
      }
    }
    let start = sample(candidate.source_range[0]);
    if (sameRecording) start = sample(previous.source_window.source_range[1]);
    else if (previous) start += parameters.crossfade_each_side_samples;
    const end = start + duration, next = selected[i + 1];
    const tail = next && next.source_sha256 !== candidate.source_sha256 ? parameters.crossfade_each_side_samples : 0;
    if (start < sample(candidate.source_range[0]) || end + tail > sample(candidate.source_range[1])) {
      gaps.push(`${cue.cue_id}: selected source lacks complete coverage or actual connection margin; no widening, looping or fallback song.`); break;
    }
    let connection = null;
    if (previous) connection = sameRecording ? {
      previous_piece_id: previous.piece_id, type: 'source_continuation', reason: 'Continue the actual adopted previous recording at its exact source end.',
      overlap_seconds: 0, from_source_handle_range: null, to_source_handle_range: null, fade_curve: 'raised_cosine'
    } : {
      previous_piece_id: previous.piece_id, type: 'crossfade', reason: 'A bounded technical crossfade between the actual selected sources; phrase and vocal compatibility remain pending audition.',
      overlap_seconds: seconds(parameters.crossfade_each_side_samples * 2),
      from_source_handle_range: [previous.source_window.source_range[1], seconds(sample(previous.source_window.source_range[1]) + parameters.crossfade_each_side_samples)],
      to_source_handle_range: [seconds(start - parameters.crossfade_each_side_samples), seconds(start)], fade_curve: 'raised_cosine'
    };
    const token = shaBytes(cue.cue_id).slice(0, 12), arcId = `constraint-${token}`, pieceId = `piece-${token}`;
    const piece = { piece_id: pieceId, target_range: [...cue.target_range], source_window: {
      segment_id: candidate.segment_id, asset_id: candidate.asset_id, source_sha256: candidate.source_sha256,
      candidate_source_range: [...candidate.source_range], source_range: [seconds(start),seconds(end)] },
      development_role: `Bound director purpose: ${cue.sound_goal}. Continuous selected-source development; local musical accents are not verified.`,
      silence_reason: null, connection_from: connection };
    arcs.push({ arc_id: arcId, cue_id: cue.cue_id, pieces: [piece] });
    const task = `${cue.cue_id}/arc/${arcId}/${pieceId}`, measured = candidate.technical_rms_dbfs;
    let gain = Number.isFinite(measured) ? Math.max(-6, Math.min(6, parameters.target_window_proxy_dbfs - measured)) : 0;
    const peak = values.editor_music_peak_measurements?.find(row=>row.music_task_cue_id===task);
    if(peak){
      const expectedRange=[connection?.type==='crossfade'?connection.to_source_handle_range[0]:seconds(start),seconds(end+tail)];
      if(peak.source_sha256!==candidate.source_sha256||!same(peak.source_range,expectedRange)
        ||peak.sample_rate!==RATE||peak.channels!==2||peak.decoded_samples!==sample(expectedRange[1])-sample(expectedRange[0])
        ||!Number.isFinite(peak.peak_linear)||peak.peak_linear<0||!/^[a-f0-9]{64}$/.test(peak.pcm_sha256??''))fail('adopted_peak_identity_changed');
      if(peak.peak_linear>0)gain=Math.min(gain,parameters.adopted_window_peak_ceiling_dbfs-20*Math.log10(peak.peak_linear));
      if(gain < -40)fail('adopted_peak_requires_unsupported_gain');
    }
    if (!Number.isFinite(measured)) pending.push(`${cue.cue_id}: no finite source energy proxy; unity gain is a diagnostic starting point, not loudness approval.`);
    music.push({ music_task_cue_id: task, gain_db: Math.floor(gain * 100) / 100,
      fade_in_seconds: i ? 0 : Math.min(seconds(parameters.outer_fade_samples), duration / RATE / 2),
      fade_out_seconds: i === cues.length - 1 ? Math.min(seconds(parameters.outer_fade_samples), duration / RATE / 2) : 0,
      transition_reason: connection?.reason ?? 'Start the actual selected source at the episode origin; outer technical fade only.' });
    for (const id of cue.required_action_ids ?? []) {
      const action = director.music_actions.find(row => row.id === id);
      if (!action || !inside(action.target_range, cue.target_range)) fail('action_owner_or_full_range_changed');
      const replaced = action.requirement === 'response' && connection?.type === 'crossfade'
        && sample(action.target_range[0]) === sample(cue.target_range[0]);
      actions.push({ action_id: id, music_task_cue_id: task, target_range: [...action.target_range],
        response_kind: replaced ? 'replace' : 'hold',
        reason: replaced ? `Execute the actual selected recording replacement at this action entry: ${action.intent}. Its dramatic effect remains unverified.`
          : action.requirement === 'hold' ? `Preserve the requested source hold: ${action.intent}. Musical suitability remains unverified.`
          : `UNRESOLVED required musical response: ${action.intent}. The current editor retains the selected source; no local development or accent is established.` });
    }
  }
  // A contiguous adopted recording is one gain chain. Use its most restrictive
  // measured cap, preserving the existing no-dip continuity and merged edit.
  for(let start=0;start<music.length;){
    let end=start+1;
    while(end<music.length&&arcs[end]?.pieces[0]?.connection_from?.type==='source_continuation')end++;
    const gain=Math.min(...music.slice(start,end).map(row=>row.gain_db));
    for(let index=start;index<end;index++)music[index].gain_db=gain;
    start=end;
  }
  for (const event of analysis.sound_events ?? []) {
    const matching = (candidates.sounds ?? []).filter(row => row.event_id === event.id);
    const candidate = matching.length === 1 ? matching[0] : null;
    const reviewed = matching.find(row => row.original_sound_review);
    const original = reviewed?.original_status ?? 'unknown';
    const allowed = event.decision === 'seek_asset' && director.sound_queries?.some(row => row.event_id === event.id)
      && candidate && ['dramatic','transition'].includes(event.role);
    let range = candidate?.source_range, target = event.start_seconds, anchor = candidate?.source_anchor_seconds;
    let reason = `Preserve original track: ${!allowed ? 'no unique actually selected source with an explicit current dramatic/transition seek intent' : 'the actual source/anchor cannot fit the original event clock'}.`;
    let adopt = false;
    if (allowed && valid(range) && candidate.sound_role === event.role && Number.isFinite(anchor)) {
      if (candidate.duration_role === 'bed') {
        range = [range[0], seconds(sample(range[0]) + sample(event.end_seconds) - sample(event.start_seconds))];
        adopt = inside(range, candidate.source_range) && sample(anchor) === sample(range[0]);
      } else {
        adopt = anchor >= range[0] && anchor < range[1]
          && sample(target) - (sample(anchor) - sample(range[0])) >= 0
          && sample(target) + (sample(range[1]) - sample(anchor)) <= N;
      }
      if (adopt) reason = `Deterministic diagnostic adoption of the unique actual selector choice for the bound seek intent: ${event.reason}. Anchor is technical, not a verified physical action or listening approval.`;
    }
    sounds.push({ event_id: event.id, selected_segment_id: adopt ? candidate.segment_id : null,
      decision: adopt ? 'new_asset' : 'omit', original_status: original, source_range: adopt ? range : null,
      target_seconds: target, source_anchor_seconds: adopt ? anchor : 0, gain_db: adopt ? parameters.sound_gain_db : 0,
      fade_in_seconds: adopt && candidate.duration_role === 'bed' ? .05 : 0,
      fade_out_seconds: adopt ? .05 : 0, reason, anchor_evidence: (event.evidence_ids ?? []).join(',') });
    if (!adopt && event.decision === 'seek_asset') pending.push(`${event.id}: ${reason}`);
  }
  const value = { plan: { schema_version: 2, source_video_sha256: source, arcs }, edits: {
    music_edits: music, action_responses: actions, sounds, dialogue_ducking_db: parameters.dialogue_ducking_db, uncertainties: [] },
    execution_gaps: gaps, review_pending: pending };
  if (!gaps.length) {
    if (actions.length !== (director.music_actions ?? []).length || new Set(actions.map(row => row.action_id)).size !== actions.length)
      fail('all_actions_exactly_once_required');
    compileSoundArcPlan({ plan: value.plan, director, candidates: candidates.music });
    const audit = auditMusicActionExecution({ director, plan: value.plan, edits: value.edits });
    pending.push(...audit.actions.filter(row => row.status === 'unresolved')
      .map(row => `UNRESOLVED music action ${row.action_id}: ${row.reason}`));
  }
  return value;
}

// Decode original recordings with the renderer's exact 48 kHz stereo Float32
// output format. Measure only adopted source samples, including real handles.
// No decoded/clipped delivery is used as an input and no model is invoked.
export async function measureConstraintMusicWindows(values){
  const draft=compileConstraintEpisode({...values,editor_music_peak_measurements:undefined});
  if(draft.execution_gaps.length)return [];
  const pieces=draft.plan.arcs.flatMap(arc=>arc.pieces.map(piece=>({arc,piece}))),groups=new Map(),rows=[];
  for(const [index,{arc,piece}]of pieces.entries()){
    const candidate=values.candidates.music.find(row=>row.cue_id===arc.cue_id),next=pieces[index+1]?.piece;
    const sourceRange=[piece.connection_from?.type==='crossfade'?piece.connection_from.to_source_handle_range[0]:piece.source_window.source_range[0],
      next?.connection_from?.type==='crossfade'?next.connection_from.from_source_handle_range[1]:piece.source_window.source_range[1]];
    if(!candidate?.local_path||!inside(sourceRange,candidate.source_range))fail('adopted_peak_source_required');
    const row={music_task_cue_id:`${arc.cue_id}/arc/${arc.arc_id}/${piece.piece_id}`,source_sha256:candidate.source_sha256,
      source_range:sourceRange,sample_rate:RATE,channels:2,decoded_samples:0,peak_linear:0,pcm_sha256:null};
    rows.push(row);const key=JSON.stringify([candidate.local_path,candidate.source_sha256]);
    if(!groups.has(key))groups.set(key,{source:{path:candidate.local_path,sha256:candidate.source_sha256},rows:[]});
    groups.get(key).rows.push({row,start:sample(sourceRange[0]),end:sample(sourceRange[1]),hash:createHash('sha256')});
  }
  for(const {source,rows:windows}of groups.values()){
    await verifyEvidenceBindings(source);
    await new Promise((resolve,reject)=>{
      const child=spawn('ffmpeg',['-v','error','-nostdin','-i',source.path,'-map','0:a:0','-ar',String(RATE),'-ac','2','-f','f32le','pipe:1'],{windowsHide:true,shell:false});
      let carry=Buffer.alloc(0),position=0,stderr='',failure=null;
      child.stdout.on('data',chunk=>{try{
        const bytes=carry.length?Buffer.concat([carry,chunk]):chunk,usable=bytes.length-bytes.length%8,count=usable/8;
        for(const window of windows){const begin=Math.max(position,window.start),end=Math.min(position+count,window.end);if(begin>=end)continue;
          const selected=bytes.subarray((begin-position)*8,(end-position)*8);window.hash.update(selected);
          for(let offset=0;offset<selected.length;offset+=4){const value=Math.abs(selected.readFloatLE(offset));if(!Number.isFinite(value))fail('adopted_peak_nonfinite_pcm');window.row.peak_linear=Math.max(window.row.peak_linear,value);}
          window.row.decoded_samples+=end-begin;
        }
        position+=count;carry=Buffer.from(bytes.subarray(usable));
      }catch(error){failure=error;child.kill();}});
      child.stderr.on('data',chunk=>{stderr+=chunk.toString();});child.on('error',reject);
      child.on('close',code=>{if(failure)return reject(failure);if(code!==0||carry.length)return reject(Error('constraint_editor_adopted_peak_decode_failed: '+stderr.slice(-400)));
        for(const window of windows){if(window.row.decoded_samples!==window.end-window.start)return reject(Error('constraint_editor_adopted_peak_incomplete_source'));
          window.row.pcm_sha256=window.hash.digest('hex');}resolve();});
    });
    await verifyEvidenceBindings(source);
  }
  return rows;
}

async function boundValues(inputs, trialAuthorization = null) {
  const values = {};
  for (const key of inputKeys) { if (!inputs[key]) fail('complete_original_inputs_required'); await verifyEvidenceBindings(inputs[key]); values[key] = await readJson(inputs[key].path); }
  await verifyEvidenceBindings({ path: path.resolve(path.dirname(inputs.manifest.path), values.manifest.source_video),
    sha256: values.manifest.source_sha256 });
  const cache = new Map(), pending = [], vocals = {};
  for (const candidate of values.candidates.music ?? []) {
    await verifyEvidenceBindings([candidate.observation_record, candidate.selection_record, { path: candidate.local_path, sha256: candidate.source_sha256 }]);
    const selected = await readJson(candidate.selection_record.path), provenance = selected.selection_provenance;
    if (!provenance?.input || !provenance.raw_response || !provenance.selector_record) fail('actual_music_selector_required');
    await verifyEvidenceBindings(provenance);
    const context = await readJson(provenance.target_context.path);
    await verifyEvidenceBindings([context.analysis, context.director, context.manifest]);
    if (context.source_video_sha256 !== values.manifest.source_sha256
      || context.analysis.sha256 !== inputs.analysis.sha256 || context.manifest.sha256 !== inputs.manifest.sha256
      || !same(await readJson(context.director.path), values.director)) fail('actual_selected_story_changed');
    // Recovered selections preserve the original request path. Verify that
    // original immutable model record, not a later zero-call accounting wrapper.
    const originalPath = path.join(path.dirname(provenance.input.path), 'selection-record.json');
    let verified = cache.get(originalPath);
    if (!verified) { verified = await verifyCompletedMaterialSelection({ path: originalPath, sha256: await hashFile(originalPath) }); cache.set(originalPath, verified); }
    const actual = verified.raw.value.decisions.find(row => row.cue_id === candidate.cue_id && row.kind === 'music');
    const task = verified.request.tasks.find(row => row.cue_id === candidate.cue_id && row.kind === 'music');
    const original = task?.candidates.find(row => row.segment_id === candidate.segment_id);
    if (verified.record.input.sha256 !== provenance.input.sha256 || verified.record.raw_response.sha256 !== provenance.raw_response.sha256
      || !same(verified.request.target_context, provenance.target_context)
      || verified.raw.source_video_sha256 !== values.manifest.source_sha256 || !actual?.selected_segment_ids.includes(candidate.segment_id)
      || original?.source_sha256 !== candidate.source_sha256 || !same(original.source_range, candidate.source_range)
      || (original.technical_energy?.rms_dbfs ?? null) !== (candidate.technical_rms_dbfs ?? null)
      || !same(task.target_range, candidate.allowed_target_range)) fail('actual_selection_or_source_changed');
    const observation = verified.observations.find(row => row.binding.sha256 === candidate.observation_record.sha256)?.value;
    if (!observation || observation.source_sha256 !== candidate.source_sha256 || !inside(candidate.source_range, observation.source_range))
      fail('actual_selected_observation_changed');
    vocals[candidate.observation_record.sha256] = observation.observation?.vocal_type ?? 'unknown';
    pending.push(...actual.unresolved_gaps.map(row => `${candidate.cue_id} actual selector pending: ${row}`));
  }
  const explorations = constraintEditorExplorationEvidence(constraintEditorDirection(values).deferred, [...cache.values()]);
  pending.push(...explorations.map(row => `${row.cue_id} actual words comparison preserved: ${JSON.stringify(row)}`));
  let authorized = false;
  if (trialAuthorization) {
    await verifyEvidenceBindings(trialAuthorization); const authorization = await readJson(trialAuthorization.path);
    if (authorization.kind !== 'direct_human_single_episode_trial_request'
      || authorization.source?.sha256 !== values.manifest.source_sha256 || authorization.material_or_listening_approval !== false)
      fail('short_diagnostic_seam_authorization_changed');
    authorized = true;
  }
  const result={ ...values, editor_selection_pending: pending, editor_vocals: vocals,
    editor_unverified_short_seam_authorized: authorized };
  result.editor_music_peak_measurements=await measureConstraintMusicWindows(result);
  return result;
}
async function stable(file, value) {
  try { return await saveJson(file, value); } catch (error) { if (error.code !== 'EEXIST') throw error;
    if (!same(await readJson(file), value)) fail('immutable_execution_changed'); return { path: path.resolve(file), sha256: await hashFile(file) }; }
}

export async function executeConstraintEpisodeEditor({ config, inputs, directory }) {
  if (!constraintEditorEnabled(config)) fail('explicit_policy_required');
  await validateIndependentMusicPackPolicy(config, { outputDirectory: config.output_dir, operation: 'prepare_independent_music_materials' });
  const values = await boundValues(inputs, config.research_trial_authorization), value = compileConstraintEpisode(values);
  const projected = constraintEditorDirection(values);
  const raw = { schema_version: 1, kind: 'constraint_episode_editor_result', execution_kind: 'deterministic_constraint_editor',
    editor_strategy: constraintEditorRevision, editor_module_sha256: await hashFile(moduleFile), parameters,
    action_execution_audit_module_sha256: await hashFile(actionAuditModuleFile),
    source_video_sha256: values.manifest.source_sha256, inputs, value,
    adopted_music_peak_measurements:values.editor_music_peak_measurements,
    effective_director: projected.director, deferred_words: projected.deferred, policy: {
      mode: config.mode, material_strategy: config.material_strategy, automatic_trial: config.automatic_trial,
      trial_review_policy: config.trial_review_policy, source_policy: config.source_policy, editor_strategy: config.editor_strategy,
      research_trial_authorization: config.research_trial_authorization ?? null },
    output_directory: path.resolve(config.output_dir), completion_status: value.execution_gaps.length ? 'execution_gap' : 'complete',
    actual_deterministic_editing_executed: true, actual_runtime_executed: false, actual_model_parts_executed: false,
    new_model_calls: 0, actual_audio_processed: true, actual_audio_hearing_approved: false,
    qualified: false, artistic_approval: false, production_approval: false };
  raw.action_execution_audit = auditMusicActionExecution({ director: projected.director, plan: value.plan, edits: value.edits });
  const binding = await stable(path.join(directory, 'execution.json'), raw);
  return { ...raw, raw_response: binding, constraint_editor_execution: binding, cli_receipts: [] };
}

export async function verifyConstraintEditorExecution(binding, { sourceSha, edits, soundEdits, directorBinding } = {}) {
  await verifyEvidenceBindings(binding); const raw = await readJson(binding.path);
  if (raw.kind !== 'constraint_episode_editor_result' || raw.execution_kind !== 'deterministic_constraint_editor'
    || raw.editor_strategy !== constraintEditorRevision || raw.editor_module_sha256 !== await hashFile(moduleFile)
    || raw.action_execution_audit_module_sha256 !== await hashFile(actionAuditModuleFile)
    || !same(raw.parameters, parameters) || raw.actual_deterministic_editing_executed !== true
    || raw.actual_runtime_executed !== false || raw.actual_model_parts_executed !== false || raw.new_model_calls !== 0
    || raw.actual_audio_processed !== true || raw.actual_audio_hearing_approved !== false || raw.qualified !== false
    || raw.artistic_approval !== false || raw.production_approval !== false || raw.completion_status !== 'complete'
    || sourceSha && raw.source_video_sha256 !== sourceSha || !constraintEditorEnabled(raw.policy)) fail('execution_identity_changed');
  await validateIndependentMusicPackPolicy(raw.policy, { outputDirectory: raw.output_directory, operation: 'prepare_independent_music_materials' });
  const values = await boundValues(raw.inputs, raw.policy.research_trial_authorization), recomputed = compileConstraintEpisode(values);
  const projected = constraintEditorDirection(values);
  if (raw.source_video_sha256 !== values.manifest.source_sha256 || !same(raw.value, recomputed)
    ||!same(raw.adopted_music_peak_measurements,values.editor_music_peak_measurements)
    || !same(raw.effective_director, projected.director) || !same(raw.deferred_words, projected.deferred)
    || !same(raw.action_execution_audit, auditMusicActionExecution({ director: projected.director, plan: recomputed.plan, edits: recomputed.edits }))
    || edits && !same(raw.value.edits, edits) || soundEdits && !same(raw.value.edits.sounds, soundEdits)) fail('execution_replay_changed');
  if (directorBinding) {
    await verifyEvidenceBindings(directorBinding);
    if (!same(await readJson(directorBinding.path), raw.effective_director)) fail('derived_render_direction_changed');
  }
  return { editor_strategy: constraintEditorRevision, execution: binding, source_video_sha256: raw.source_video_sha256,
    exact_recomputation_verified: true, action_execution_audit: raw.action_execution_audit,
    new_model_calls: 0, qualified: false, production_approval: false };
}
