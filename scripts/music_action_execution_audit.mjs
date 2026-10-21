// Execution evidence only. This module does not hear music or certify that a
// technically real change has the intended dramatic or artistic effect.
import { actionTasksCover, compileActionPieceMappings, gainAt, validateGainEnvelope } from './music_edit_operation_contract.mjs';
export const musicActionExecutionAuditRevision = 'music_action_execution_audit_v1';
const RATE = 48000;
const sample = value => Math.round(value * RATE);
const validRange = value => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && value[0] >= 0 && sample(value[1]) > sample(value[0]);
const sameRange = (a,b) => validRange(a) && validRange(b)
  && sample(a[0]) === sample(b[0]) && sample(a[1]) === sample(b[1]);
const contains = (outer,inner) => validRange(outer) && validRange(inner)
  && sample(outer[0]) <= sample(inner[0]) && sample(outer[1]) >= sample(inner[1]);

export function auditMusicActionExecution({director,plan,edits,compiled}) {
  if (!director || !plan || !edits || director.source_video_sha256 !== plan.source_video_sha256
    || !Array.isArray(director.music_actions) || !Array.isArray(plan.arcs)
    || !Array.isArray(edits.action_responses) || !Array.isArray(edits.music_edits))
    throw Error('music_action_execution_inputs_invalid');
  if (edits.schema_version === 2) return auditV2({ director, plan, edits, compiled });
  const pieces=plan.arcs.flatMap(arc=>arc.pieces.map(piece=>({arc,piece,
    task_id:`${arc.cue_id}/arc/${arc.arc_id}/${piece.piece_id}`})));
  const rows=director.music_actions.map(action=>{
    const responses=edits.action_responses.filter(row=>row.action_id===action.id);
    const response=responses.length===1?responses[0]:null;
    const matches=pieces.filter(row=>row.task_id===response?.music_task_cue_id
      && contains(row.piece.target_range,action.target_range));
    const match=matches.length===1?matches[0]:null, piece=match?.piece;
    const musicEdits=edits.music_edits.filter(row=>row.music_task_cue_id===match?.task_id);
    const parent=director.cues?.find(row=>row.cue_id===match?.arc.cue_id);
    const bound=Boolean(response&&match&&musicEdits.length===1&&sameRange(response.target_range,action.target_range)
      && parent?.required_action_ids?.includes(action.id)&&piece.source_window
      && validRange(piece.source_window.source_range));
    const previous=piece?.connection_from&&pieces.find(row=>row.piece.piece_id===piece.connection_from.previous_piece_id)?.piece;
    const atEntry=bound&&sample(action.target_range[0])===sample(piece.target_range[0]);
    const physicalReplacement=Boolean(atEntry&&previous&&piece.connection_from.type!=='source_continuation'
      && sample(previous.target_range[1])===sample(piece.target_range[0])
      && previous.source_window?.source_sha256!==piece.source_window.source_sha256);
    const evidence=bound?{music_task_cue_id:match.task_id,piece_id:piece.piece_id,
      source_sha256:piece.source_window.source_sha256,
      adopted_source_range:piece.source_window.source_range,
      mapped_action_source_range:action.target_range.map(t=>(sample(piece.source_window.source_range[0])+sample(t)-sample(piece.target_range[0]))/RATE),
      source_change_at_action_start:physicalReplacement,
      connection:atEntry?piece.connection_from:null,
      music_edit:musicEdits[0]}:null;
    let status='unresolved',reason;
    if(!bound) reason='Action response is not uniquely bound to its actual piece, source interval and edit.';
    else if(action.requirement==='hold'&&response.response_kind==='hold'){
      status='executed_hold';reason='The requested hold retains one bound source piece across the complete action range; musical suitability is not assessed.';
    }else if(action.requirement==='response'&&response.response_kind==='replace'&&physicalReplacement){
      status='executed_edit';reason='An actual selected recording replacement begins at the action entry. This proves the edit occurred, not its dramatic suitability.';
    }else if(action.requirement==='response'&&response.response_kind==='source_development'){
      reason='No source-local development evidence is bound to this action. Text, whole-window energy, technical gain and full source coverage do not prove the required musical development.';
    }else if(action.requirement==='hold'){
      reason='The requested hold is mislabeled as another response kind; preserve the historical record and repair only new producer output.';
    }else if(action.requirement==='response'){
      reason='The requested response currently retains the source without an action-specific executable change or bound source-local development evidence.';
    }else reason='The action requirement is unsupported or missing; no implicit response or intentional silence is inferred.';
    return {action_id:action.id,story_beat_id:action.story_beat_id??null,target_range:action.target_range,
      requirement:action.requirement??null,intent:action.intent,response_kind:response?.response_kind??null,
      status,reason,execution_evidence:evidence,source_development_evidence:null,
      dramatic_effect_verified:false,artistic_approval:false};
  });
  return {schema_version:1,kind:musicActionExecutionAuditRevision,source_video_sha256:plan.source_video_sha256,
    status:rows.some(row=>row.status==='unresolved')?'unresolved_actions':'execution_evidence_complete',
    summary:{actions:rows.length,executed_holds:rows.filter(row=>row.status==='executed_hold').length,
      executed_edits:rows.filter(row=>row.status==='executed_edit').length,
      unresolved:rows.filter(row=>row.status==='unresolved').length,
      unresolved_required_responses:rows.filter(row=>row.status==='unresolved'&&row.requirement==='response').length},
    actions:rows,actual_audio_hearing_performed:false,qualified:false,production_approval:false,
    limitations:['This is an execution audit, not independent musical or dramatic assessment.',
      'Source-development claims require a future explicit verified source-local evidence adapter; arbitrary booleans, descriptions and signal scores are not accepted.',
      'A genuine recording replacement may still be musically wrong. No gain change is inserted to manufacture a passing result.']};
}

function auditV2({ director, plan, edits, compiled }) {
  const pieces = plan.arcs.flatMap(arc => arc.pieces.map(piece => ({ arc, piece,
    task_id: `${arc.cue_id}/arc/${arc.arc_id}/${piece.piece_id}` })));
  const bindings = compiled?.music_action_bindings;
  const actualCues = compiled?.plan?.cues?.filter(cue => cue.track === 'bgm') ?? [];
  const assets = new Map((compiled?.plan?.assets ?? []).map(asset => [asset.id, asset]));
  const level = (cue, target) => (cue.gain_db ?? 0) + (cue.gain_envelope
    ? gainAt(cue.gain_envelope, target - cue.start_seconds) : 0);
  const levelPoints = (cue, target) => [target[0], ...(cue.gain_envelope ?? []).map(point => cue.start_seconds + point.offset_seconds)
    .filter(t => sample(t) > sample(target[0]) && sample(t) < sample(target[1])), target[1]]
    .map(t => ({ target_seconds: t, gain_db: level(cue, t) }));
  const rows = director.music_actions.map(action => {
    const responses = edits.action_responses.filter(row => row.action_id === action.id);
    const response = responses.length === 1 ? responses[0] : null, operation = response?.actual_edit_operation;
    let status = 'unresolved', reason = 'Actual compiler output and exact action-to-task coverage are required.', mappings = null, evidence = null;
    try {
      if (!response || bindings?.schema_version !== 2 || !actualCues.length || !Array.isArray(compiled.selections)
        || !actionTasksCover(response, action, bindings.tasks, 2)) throw Error('actual_action_coverage_required');
      for (const id of response.music_task_cue_ids) {
        const primaryId = id.endsWith('/words') ? id.slice(0, -6) : id;
        const owners = pieces.filter(row => row.task_id === primaryId);
        if (owners.length !== 1 || !director.cues?.find(cue => cue.cue_id === owners[0].arc.cue_id)?.required_action_ids?.includes(action.id)
          || edits.music_edits.filter(edit => edit.music_task_cue_id === id).length !== 1) throw Error('actual_action_owner_required');
      }
      mappings = compileActionPieceMappings(response, { cues: bindings.tasks }, actualCues, compiled.selections);
      for (const map of mappings) {
        const cue = actualCues.find(row => row.id === map.plan_cue_id), selected = bindings.sources.find(row => row.cue_id === map.music_task_cue_id);
        if (!selected || assets.get(cue.asset_id)?.sha256 !== selected.source_sha256
          || !contains(selected.source_range, map.source_range)) throw Error('actual_selected_source_identity_required');
        const owner = pieces.find(row => row.task_id === map.music_task_cue_id);
        if (owner && (selected.source_sha256 !== owner.piece.source_window?.source_sha256
          || !sameRange(map.source_range, map.target_range.map(t => (sample(owner.piece.source_window.source_range[0])
            + sample(t) - sample(owner.piece.target_range[0])) / RATE)))) throw Error('actual_piece_source_position_changed');
        if (cue.gain_envelope) validateGainEnvelope(cue.gain_envelope,
          cue.source_out_seconds - cue.source_in_seconds, cue.gain_db ?? 0);
      }
      const actual = mappings.map(map => { const cue = actualCues.find(row => row.id === map.plan_cue_id);
        return { ...map, asset_id: cue.asset_id, source_sha256: assets.get(cue.asset_id).sha256,
          gain_points: levelPoints(cue, map.target_range), fade_in_seconds: cue.fade_in_seconds ?? 0,
          fade_out_seconds: cue.fade_out_seconds ?? 0 }; });
      const unique = [...new Map(actual.map(row => [JSON.stringify([row.plan_cue_id, row.target_range]), row])).values()]
        .sort((a, b) => a.target_range[0] - b.target_range[0]);
      const anchor = operation.anchor_seconds;
      const changes = [];
      for (let i = 1; i < unique.length; i++) {
        const before = unique[i - 1], after = unique[i], boundary = after.target_range[0];
        if (sample(before.target_range[1]) !== sample(boundary)) continue;
        changes.push({ target_seconds: boundary, from_source_sha256: before.source_sha256, to_source_sha256: after.source_sha256,
          from_source_seconds: before.source_range[1], to_source_seconds: after.source_range[0],
          source_changed: before.source_sha256 !== after.source_sha256 || sample(before.source_range[1]) !== sample(after.source_range[0]),
          gain_change_db: after.gain_points[0].gain_db - before.gain_points.at(-1).gain_db });
      }
      // Also inspect a real predecessor at the action entry. It may lie outside
      // the action and is therefore not one of its coverage mappings.
      if (anchor !== null) {
        const after = actualCues.find(cue => sample(cue.start_seconds) === sample(anchor));
        const before = after && actualCues.find(cue => cue.id !== after.id
          && sample(cue.start_seconds + cue.source_out_seconds - cue.source_in_seconds) === sample(anchor));
        if (before && !changes.some(change => sample(change.target_seconds) === sample(anchor))) changes.push({
          target_seconds: anchor, from_source_sha256: assets.get(before.asset_id)?.sha256, to_source_sha256: assets.get(after.asset_id)?.sha256,
          from_source_seconds: before.source_out_seconds, to_source_seconds: after.source_in_seconds,
          source_changed: assets.get(before.asset_id)?.sha256 !== assets.get(after.asset_id)?.sha256
            || sample(before.source_out_seconds) !== sample(after.source_in_seconds),
          gain_change_db: level(after, anchor) - level(before, anchor) });
      }
      const points = unique.flatMap(row => row.gain_points), dynamicGain = points.some(point => Math.abs(point.gain_db - points[0].gain_db) > .05);
      const atAnchor = changes.find(change => anchor !== null && sample(change.target_seconds) === sample(anchor));
      evidence = { origin: 'actual_compiled_renderer_operands', operation, actual_piece_mappings: actual, changes,
        actual_audio_hearing_performed: false, source_instrumentation_verified: false, lyric_content_verified: false };
      if (action.requirement === 'hold' && response.response_kind === 'hold' && operation.kind === 'hold') {
        const uninterrupted = changes.every(change => !change.source_changed) && !dynamicGain
          && unique.every(row => { const cue = actualCues.find(item => item.id === row.plan_cue_id);
            const end = cue.start_seconds + cue.source_out_seconds - cue.source_in_seconds;
            return !(sample(cue.start_seconds) > sample(action.target_range[0]) && (cue.fade_in_seconds ?? 0) > 0)
              && !(sample(end) < sample(action.target_range[1]) && (cue.fade_out_seconds ?? 0) > 0); });
        if (uninterrupted) { status = 'executed_hold'; reason = 'Actual source positions remain continuous across the action without internal automation or fade holes.'; }
        else reason = 'The claimed hold contains a real source/gain change or an internal fade; it is not a continuous hold.';
      } else if (action.requirement !== 'response' || operation.kind === 'hold') reason = 'Requested response/hold and actual operation are inconsistent.';
      else if (operation.kind === 'source_development') reason = 'No independently verified source-local musical-development fact is bound. Text, whole-window energy and technical automation cannot approve this claim.';
      else if (!['edit_operation', 'replace'].includes(response.response_kind)
        || response.response_kind === 'replace' && operation.kind !== 'source_switch') reason = 'Response kind does not name its actual edit operation.';
      else if (operation.kind === 'source_switch' && atAnchor?.source_changed) { status = 'executed_edit'; reason = 'A real recording or non-contiguous source-position switch occurs at the declared target anchor.'; }
      else if (operation.kind === 'gain_change' && atAnchor && Math.abs(atAnchor.gain_change_db) > .05) { status = 'executed_edit'; reason = 'Actual adopted pieces change their technical gain at the declared anchor; instrumentation and dramatic effect remain unverified.'; }
      else if (operation.kind === 'gain_envelope' && dynamicGain) { status = 'executed_edit'; reason = 'The compiled renderer curve performs non-constant gain automation over the action. This is not source orchestration evidence.'; }
      else if (operation.kind === 'accent' && anchor !== null) {
        const peak = points.find(point => sample(point.target_seconds) === sample(anchor));
        const left = points.filter(point => sample(point.target_seconds) < sample(anchor)).at(-1), right = points.find(point => sample(point.target_seconds) > sample(anchor));
        if (peak && left && right && peak.gain_db >= left.gain_db + 1 && peak.gain_db >= right.gain_db + 1) {
          status = 'executed_edit'; reason = 'A real bounded amplitude accent is compiled at the anchor. A musical transient, audibility and narrative appropriateness are not inferred.';
          evidence.accent_kind = 'authored_amplitude_accent'; evidence.musical_accent_verified = false;
        } else reason = 'No actual bounded gain accent peaks at the declared anchor.';
      } else if (operation.kind === 'lyric_entry' && anchor !== null && unique.some(row => {
        const cue = actualCues.find(item => item.id === row.plan_cue_id);
        return cue.music_role === 'words_candidate' && sample(cue.start_seconds) === sample(anchor);
      })) { status = 'executed_edit'; reason = 'The actual selected words-input track enters at the declared anchor. Singing, lyrics and complete phrase boundaries still require separate source evidence.'; }
      else reason = 'The declared operation is absent from the actual renderer operands at its action anchor.';
    } catch (error) { reason = error.message; }
    return { action_id: action.id, story_beat_id: action.story_beat_id ?? null, target_range: action.target_range,
      requirement: action.requirement ?? null, intent: action.intent, response_kind: response?.response_kind ?? null,
      actual_edit_operation: operation ?? null, status, reason, execution_evidence: evidence,
      source_development_evidence: null, dramatic_effect_verified: false, artistic_approval: false };
  });
  return { schema_version: 2, kind: 'music_action_execution_audit_v2', source_video_sha256: plan.source_video_sha256,
    status: rows.some(row => row.status === 'unresolved') ? 'unresolved_actions' : 'execution_evidence_complete',
    summary: { actions: rows.length, executed_holds: rows.filter(row => row.status === 'executed_hold').length,
      executed_edits: rows.filter(row => row.status === 'executed_edit').length, unresolved: rows.filter(row => row.status === 'unresolved').length,
      unresolved_required_responses: rows.filter(row => row.status === 'unresolved' && row.requirement === 'response').length },
    actions: rows, execution_scope: 'compiled_renderer_operands', rendered_audio_execution_verified: false,
    actual_audio_hearing_performed: false, qualified: false, production_approval: false,
    limitations: ['Compiled editing evidence does not approve sound facts, musical suitability, audibility or dramatic effect.',
      'Source development remains unresolved without exact independently verified local source facts.',
      'Gain automation and amplitude accents never certify orchestration, artistic development or a heard musical transient.'] };
}

// The caller binds the real report/stems and plan files before calling this.
// Match renderer placements, not a "rendered:true" claim on a model response.
export function verifyMusicActionRenderExecution(audit, compiled, report) {
  if (audit.schema_version !== 2 || !Array.isArray(report?.cues)
    || report.sample_rate !== RATE || report.source_sha256 !== audit.source_video_sha256
    || !report.input_binding?.asset_sha256 || !Number.isSafeInteger(report.duration_samples)
    || report.duration_samples <= 0 || !Object.keys(report.output_sha256 ?? {}).length)
    throw Error('music_action_actual_render_report_required');
  const cues = compiled.plan.cues.filter(cue => cue.track === 'bgm');
  const assets = new Map(compiled.plan.assets.map(asset => [asset.id, asset]));
  for (const cue of cues) {
    const rows = report.cues.filter(row => row.id === cue.id), actual = rows.length === 1 ? rows[0] : null;
    const expectedEnvelope = cue.gain_envelope?.map(point => ({ offset_sample: sample(point.offset_seconds), gain_db: point.gain_db })) ?? null;
    if (!actual || actual.track !== 'bgm' || actual.asset_id !== cue.asset_id
      || report.input_binding.asset_sha256[cue.asset_id] !== assets.get(cue.asset_id)?.sha256
      || actual.source_in_sample !== sample(cue.source_in_seconds) || actual.source_out_sample !== sample(cue.source_out_seconds)
      || actual.start_sample !== sample(cue.start_seconds) || actual.end_sample !== sample(cue.start_seconds)
        + sample(cue.source_out_seconds) - sample(cue.source_in_seconds)
      || actual.gain_db !== (cue.gain_db ?? 0)
      || actual.fade_in_samples !== sample(cue.fade_in_seconds ?? 0) || actual.fade_out_samples !== sample(cue.fade_out_seconds ?? 0)
      || actual.fade_curve !== (cue.fade_curve ?? 'linear')
      || JSON.stringify(actual.gain_envelope ?? null) !== JSON.stringify(expectedEnvelope))
      throw Error('music_action_render_placement_or_source_mismatch');
  }
  if (report.cues.filter(cue => cue.track === 'bgm').length !== cues.length)
    throw Error('music_action_unbound_extra_render_music');
  return { ...audit, execution_scope: 'actual_renderer_placement_report', rendered_audio_execution_verified: true,
    rendered_duration_samples: report.duration_samples, rendered_output_sha256: report.output_sha256,
    // This is actual arithmetic/render execution, still no listener approval.
    actual_audio_hearing_performed: false, qualified: false, production_approval: false };
}
