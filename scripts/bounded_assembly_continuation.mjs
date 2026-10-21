// A bounded model view of an ACTUAL adopted tail. Full source/edit/why/proof
// remains in the immutable caller; no return, curve or editing operand changes.
import {shaBytes} from './audio_api.mjs';
export const boundedAssemblyContinuationRevision='actual-tail-operands-host-reasons-v1';
export const boundedTailEnvelopeMaxItems=24;
export const boundedPieceIdentifierMaxLength=32;
const canonical=v=>JSON.stringify(v,(_,r)=>r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])):r);

export function bindActualTailOperandView(data,aliases){
  if(data.bounded_assembly_continuation_revision!==boundedAssemblyContinuationRevision)return;
  const tail=data.actual_previous_assembly_tail;if(!tail)return;
  const move=(object,key,pointer,role)=>{if(!object||!Object.hasOwn(object,key))return;
    aliases.push({pointer,role,value_sha256:shaBytes(canonical(object[key]))});delete object[key];};
  const base='/data/actual_previous_assembly_tail';
  for(const key of ['source_video_sha256','previous_part_response','selected_candidate','basis','arc_id','cue_id'])
    move(tail,key,base+'/'+key,'actual_previous_tail_full_identity_and_execution_in_bound_host');
  for(const key of ['development_role','silence_reason'])move(tail.piece,key,base+'/piece/'+key,'actual_previous_creative_reason_in_bound_host');
  move(tail.piece?.connection_from,'reason',base+'/piece/connection_from/reason','actual_previous_connection_reason_in_bound_host');
  move(tail.music_edit,'transition_reason',base+'/music_edit/transition_reason','actual_previous_edit_reason_in_bound_host');
  move(tail.music_edit,'music_task_cue_id',base+'/music_edit/music_task_cue_id','actual_previous_edit_is_bound_to_this_exact_tail_piece');
  for(const key of ['asset_id','source_sha256','candidate_source_range'])
    move(tail.piece?.source_window,key,base+'/piece/source_window/'+key,'actual_previous_segment_identity_in_bound_selected_candidate');
  const points=tail.music_edit?.gain_envelope;
  if(Array.isArray(points)){
    if(points.length>boundedTailEnvelopeMaxItems)throw Error('bounded_assembly_actual_tail_curve_exceeds_declared_schema');
    aliases.push({pointer:base+'/music_edit/gain_envelope',role:'lossless_complete_actual_gain_points_table',value_sha256:shaBytes(canonical(points))});
    tail.music_edit.gain_envelope={encoding:'complete-actual-relative-gain-points-v1',columns:['offset_seconds','gain_db'],
      rows:points.map(p=>[p.offset_seconds,p.gain_db])};
  }
}

// JSON.stringify of ANY finite IEEE-754 number takes at most 25 ASCII bytes.
// Quoted 25-byte placeholders deliberately add two MORE bytes than numbers.
// IDs not fixed by the host are ASCII-only, <=32; no JSON-escape multiplier.
// This uncompressed operand view upper-bounds the lossless inline table view.
// The view is added OUTSIDE the existing inline dictionary, so no dictionary
// indices can shift. Include its key and the maximum business-shape growth
// when the next schema pins dialogue ducking to the actual first-part number:
// "num" -> "enum(<at most 25 bytes>)" grows by at most 28 bytes.
// The gain-table instruction exists in both envelopes and host digests stay
// 64 B. Worker/schema/calibration is included by session.inputBudget.
export function boundedActualTailCapacity(input,{originalActionCount}={}){
  const data=input.data,part=data.mother_action_partition;
  if(data.bounded_assembly_continuation_revision!==boundedAssemblyContinuationRevision||!part)
    throw Error('bounded_assembly_explicit_tail_capacity_required');
  const number='9'.repeat(25),pair=[number,number],id='x'.repeat(boundedPieceIdentifierMaxLength);
  const sourceWindows=(data.candidates.music??[]).map(c=>({segment_id:c.segment_id,source_range:pair}));
  sourceWindows.push(null);
  const total=originalActionCount;
  if(!Number.isInteger(total)||total<2)throw Error('bounded_assembly_original_action_count_required');
  let maxBytes=0;
  for(const sourceWindow of sourceWindows){
    const value={piece:{piece_id:id,target_range:pair,source_window:sourceWindow,
      connection_from:{previous_piece_id:id,type:'source_continuation',overlap_seconds:number,
        from_source_handle_range:pair,to_source_handle_range:pair,fade_curve:'raised_cosine'}},
      music_edit:{gain_db:number,fade_in_seconds:number,fade_out_seconds:number,
        gain_envelope:{encoding:'complete-actual-relative-gain-points-v1',columns:['offset_seconds','gain_db'],
          rows:Array.from({length:boundedTailEnvelopeMaxItems},()=>pair)}},dialogue_ducking_db:number,actual_audio_hearing_approved:false};
    const serialized=JSON.stringify(value).replaceAll('"'+number+'"',number);
    maxBytes=Math.max(maxBytes,Buffer.byteLength(serialized));
  }
  const keyBytes=Buffer.byteLength(',"actual_previous_assembly_tail":'),schemaEnumBytes=28,tax=keyBytes+schemaEnumBytes;
  return {revision:boundedAssemblyContinuationRevision,max_gain_envelope_items:boundedTailEnvelopeMaxItems,
    numeric_json_byte_bound:25,arbitrary_identifier_max_length:boundedPieceIdentifierMaxLength,arbitrary_identifiers_ascii_only:true,
    raw_operand_json_upper_bound_bytes:maxBytes,model_tail_key_bytes:keyBytes,
    pinned_ducking_business_shape_growth_bound_bytes:schemaEnumBytes,encoding_and_binding_tax_bytes:tax,
    reserved_input_tokens:Math.ceil((maxBytes+tax)/3),
    full_actual_curve_and_operands_retained:true,creative_reasons_and_execution_identity_host_bound:true,
    model_tail_outside_inline_dictionary:true,original_action_count:total,
    reserve_excludes_no_worker_schema_or_cli_context:true,actual_next_envelope_must_still_be_reestimated:true};
}
