import { shaBytes } from './audio_api.mjs';
import { encodeBoundedInlineRecords, expandBoundedInlineRecords } from './bounded_inline_record_encoding.mjs';
import {bindActualTailOperandView,boundedAssemblyContinuationRevision} from './bounded_assembly_continuation.mjs';
import {isValidatedIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {sfxEventFunctionRevision,validatePreparedSoundFunction,validateObservedAssemblySoundFunction,
  isObservedAssemblySoundCandidate,soundUsageSchema} from './sfx_event_function.mjs';

export const assemblyConsumerProjectionRevision = 'assembly-editing-facts-and-constraints-v1';
export const assemblyEditingProjectionRevision = 'assembly-current-editing-host-literals-v2';
export const assemblyEditingPermissionsRevision = 'assembly-current-editing-permissions-v3';
export const assemblySoundOwnershipRevision = 'assembly-current-editing-sound-ownership-v4';
export const assemblyMotherActionEditingRevision = 'assembly-mother-action-inline-records-v5';
export const boundedPartScopeRevision='owned-target-clock-bounds-v1';
export const assemblyOwnedPartClockBoundsRevision='assembly-owned-part-clock-bounds-v6';
export const diagnosticAssemblySoundPolicyRevision='independent-diagnostic-sound-adoption-v1';
export const diagnosticAssemblySoundPrompt='Diagnostic dramatic/transition candidates may new_asset for provisional trial while qualification remains false. Missing formal approval alone is no veto. Judge bound source SHA/window/anchor/role, contamination, fit, masking and mother-music duplication; unsuitable optional effects may omit with reasons. Unheard identity/cleanliness/fit/sync/audition stay review_pending; PANN/filename/PCM do not verify sound meaning. This permission excludes unknown physical/Foley/environment and unreviewed ambience. Required omissions still leave gaps/incomplete coverage; never claim hearing, artistic, use or production approval.';
export function withDiagnosticAssemblySoundPolicy(original,policy){
  if(!isValidatedIndependentMusicPackPolicy(policy)||policy.review_policy!=='diagnostic_candidates'
    ||policy.production_approval!==false||policy.qualification_granted!==false)
    throw Error('assembly_diagnostic_sound_validated_host_policy_required');
  const input=structuredClone(original);
  input.data.diagnostic_sound_adoption_policy={revision:diagnosticAssemblySoundPolicyRevision,
    source_video_sha256:input.data.source_video_sha256,host_authorization:{...policy.authorization},
    allowed_sound_roles:['dramatic','transition'],qualification_granted:false,original_sound_fact_approval:false,
    artistic_approval:false,production_approval:false};
  input.prompt+=' '+diagnosticAssemblySoundPrompt;
  validateDiagnosticAssemblySoundPolicy(input);
  return input;
}
export function validateDiagnosticAssemblySoundPolicy(input){
  const policy=input.data?.diagnostic_sound_adoption_policy;if(policy===undefined)return;
  if(input.stage!=='current_research_episode_assembly'||policy?.revision!==diagnosticAssemblySoundPolicyRevision
    ||!/^[a-f0-9]{64}$/.test(policy.source_video_sha256??'')||policy.source_video_sha256!==input.data.source_video_sha256
    ||!policy.host_authorization?.path||!/^[a-f0-9]{64}$/.test(policy.host_authorization.sha256??'')
    ||JSON.stringify(policy.allowed_sound_roles)!==JSON.stringify(['dramatic','transition'])
    ||['qualification_granted','original_sound_fact_approval','artistic_approval','production_approval'].some(key=>policy[key]!==false)
    ||!input.prompt.includes(diagnosticAssemblySoundPrompt))throw Error('assembly_diagnostic_sound_bound_policy_changed');
}
export const assemblySoundFunctionPrompt='For sound-event-function-v2, sound_function_intent.event_role controls the sound policy; catalogue_kind/asset_kind is a retrieval hint, so a dramatic bed is not an environmental claim. Preserve the supplied sound_usage.function, usable_source_range, selector_adopt_reason and review_pending. A bed starts at usable_source_range[0] and spans its current event at 48kHz inside that range; never upgrade a point selection to a bed. These are unapproved selection hypotheses, not verified sustained sound/cleanliness/fit. Diagnostic unknown qualifications alone remain pending, not a veto; actual functional conflict, contamination, source/anchor/coverage limits still matter. Unsuitable candidates may omit; a seek_asset omission remains a required coverage gap, even if the model calls it optional. True unknown physical/Foley/environment retains original; no invented observations or approvals.';
const observedPoolRevision='observed-candidates-final-assembly-v1';
export const assemblyObservedSoundPoolPrompt='Observed sound candidates are alternatives, not standalone selector successes. Final sound assembly must actually compare every current event intent, full bound observations, exclusions and unmatched constraints. For new_asset author sound_usage={segment_id,function:point/bed/ambience,usable_source_range,basis,review_pending} plus the edit reason; omit has sound_usage:null. Use only the observed source window and supplied measured anchor; bed spans the full event from the permitted window start, never a point promoted to a bed. sound_function_intent.event_role controls policy; catalogue_kind is only retrieval. Preserve any legacy selected usage/reason. Predictions, energy and filenames do not verify identity, cleanliness, fit, sustained function or hearing. Unknown qualifications remain pending; actual contamination, conflicting intent, exclusions, source/anchor/coverage limits may require omission. A seek_asset omission remains a required gap. Unknown physical/Foley/environment retains original; no invented selector, observation, usage approval or production approval.';
function observedPoolContext(input){
  const revision=input.data?.assembly_sfx_pool_contract_revision;
  if(revision!==undefined&&revision!==observedPoolRevision)throw Error('assembly_sound_function_pool_revision_changed');
  const enabled=revision===observedPoolRevision;
  if(!enabled&&(input.data?.candidates?.sounds??[]).some(isObservedAssemblySoundCandidate))
    throw Error('assembly_sound_function_explicit_pool_context_required');
  return enabled;
}
const soundFunctionPrompt=input=>observedPoolContext(input)?assemblyObservedSoundPoolPrompt:assemblySoundFunctionPrompt;
export function applyObservedAssemblySoundSchema(schema){
  const output=structuredClone(schema),item=output?.properties?.edits?.properties?.sounds?.items;
  if(!item?.properties||!Array.isArray(item.required))throw Error('assembly_sound_function_sound_schema_required');
  item.properties.sound_usage=structuredClone(soundUsageSchema);
  item.required=[...new Set([...item.required,'sound_usage'])];
  return output;
}
function preparedSoundFunctions(input){
  const sounds=input.data?.candidates?.sounds??[],events=input.data?.analysis?.sound_events??[];
  observedPoolContext(input);
  return sounds.filter(row=>row.sound_function_intent!==undefined||row.sound_usage!==undefined||isObservedAssemblySoundCandidate(row)).map(row=>{
    const event=events.find(event=>event.id===row.event_id);
    if(!event)throw Error('assembly_sound_function_current_event_required');
    if(isObservedAssemblySoundCandidate(row)&&row.adoption_pending!==false)
      return validateObservedAssemblySoundFunction(row,event);
    return validatePreparedSoundFunction(row,event);
  });
}
export function withAssemblySoundFunctionContext(original){
  const functions=preparedSoundFunctions(original),pool=observedPoolContext(original);
  if(!functions.length&&!pool){
    if(original.data?.sfx_event_function_revision!==undefined)throw Error('assembly_sound_function_candidates_required');
    return original;
  }
  const input=structuredClone(original);
  if(input.data.sfx_event_function_revision!==undefined&&input.data.sfx_event_function_revision!==sfxEventFunctionRevision)
    throw Error('assembly_sound_function_revision_changed');
  input.data.sfx_event_function_revision=sfxEventFunctionRevision;
  if(pool)input.schema=applyObservedAssemblySoundSchema(input.schema);
  const prompt=soundFunctionPrompt(input);
  if(!input.prompt.includes(prompt))input.prompt+=' '+prompt;
  validateAssemblySoundFunctionContext(input);
  return input;
}
export function validateAssemblySoundFunctionContext(input){
  const functions=preparedSoundFunctions(input),pool=observedPoolContext(input);
  if(!functions.length&&!pool){
    if(input.data?.sfx_event_function_revision!==undefined)throw Error('assembly_sound_function_candidates_required');
    return;
  }
  if(pool){
    const item=input.schema?.properties?.edits?.properties?.sounds?.items;
    if(JSON.stringify(item?.properties?.sound_usage)!==JSON.stringify(soundUsageSchema)
      ||!item.required?.includes('sound_usage'))throw Error('assembly_sound_function_pool_usage_schema_changed');
  }
  if(input.stage!=='current_research_episode_assembly'||input.data.sfx_event_function_revision!==sfxEventFunctionRevision
    ||!input.prompt.includes(soundFunctionPrompt(input)))throw Error('assembly_sound_function_bound_context_changed');
}
// Function-v2 belongs to the actual selected sound pool, not every temporal
// partition of its parent. Validate the complete parent before removing an
// inapplicable local marker; the full caller identity and owned event scope
// still bind the part. No candidate, decision or qualification is invented.
export function scopeAssemblySoundFunctionContext(parent,scoped){
  validateAssemblySoundFunctionContext(parent);
  if(parent.data?.sfx_event_function_revision===undefined)return scoped;
  const scope=scoped.data?.assembly_partition;
  if(scoped.data?.source_video_sha256!==parent.data.source_video_sha256
    ||scope?.full_input_sha256!==shaBytes(canonical(parent))||!Array.isArray(scope.owned_event_ids))
    throw Error('assembly_sound_function_parent_scope_changed');
  const original=parent.data.candidates.sounds??[],local=scoped.data.candidates.sounds??[];
  if(local.some(row=>!scope.owned_event_ids.includes(row.event_id)
    ||!original.some(candidate=>canonical(candidate)===canonical(row))))
    throw Error('assembly_sound_function_scoped_candidate_changed');
  const functions=preparedSoundFunctions(scoped);
  if(observedPoolContext(parent)&&!observedPoolContext(scoped))throw Error('assembly_sound_function_pool_scope_changed');
  if(functions.length||observedPoolContext(scoped)){validateAssemblySoundFunctionContext(scoped);return scoped;}
  const input=structuredClone(scoped);delete input.data.sfx_event_function_revision;
  validateAssemblySoundFunctionContext(input);return input;
}
const editingRevisions = [assemblyEditingProjectionRevision, assemblyEditingPermissionsRevision, assemblySoundOwnershipRevision, assemblyMotherActionEditingRevision,assemblyOwnedPartClockBoundsRevision];
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
export const observedAssemblySoundContextRevision='observed-sound-exact-inline-contexts-v1';
const observedContextFields=[['sound_query_projection','sound_query_projections','q_'],
  ['sound_function_intent','sound_function_intents','f_']];
const observedContextFail=reason=>{throw Error('assembly_observed_sound_context_'+reason);};

// Only the explicit final sound role shares exact repeated objects. Every
// literal, exclusion and intent remains inline; the ordinary record encoder
// and legacy parent/music projections keep their existing representation.
export function expandObservedAssemblySoundContexts(original){
  const view=structuredClone(original),table=view.observed_sound_contexts;
  if(table===undefined)return view;
  if(view.assembly_sfx_pool_contract_revision!==observedPoolRevision
    ||table.revision!==observedAssemblySoundContextRevision
    ||canonical(Object.keys(table).sort())!==canonical(['revision','sound_function_intents','sound_query_projections']))
    observedContextFail('explicit_table_required');
  for(const [field,tableKey,prefix]of observedContextFields){
    if(!Array.isArray(table[tableKey]))observedContextFail('table_rows_required');
    const rows=new Map(),uses=new Map();
    for(const row of table[tableKey]){
      if(canonical(Object.keys(row).sort())!==canonical(['id','value','value_sha256'])
        ||!row.value||typeof row.value!=='object'||Array.isArray(row.value)
        ||row.value_sha256!==shaBytes(canonical(row.value))||row.id!==prefix+row.value_sha256.slice(0,16)
        ||rows.has(row.id))observedContextFail('content_hash_changed');
      rows.set(row.id,row);uses.set(row.id,0);
    }
    for(const candidate of view.candidates?.sounds??[]){
      const ref=field+'_ref';if(!Object.hasOwn(candidate,ref))continue;
      const row=rows.get(candidate[ref]);
      if(!row||Object.hasOwn(candidate,field)||candidate.assembly_sfx_pool_contract_revision!==observedPoolRevision)
        observedContextFail('reference_changed');
      candidate[field]=structuredClone(row.value);delete candidate[ref];
      uses.set(row.id,uses.get(row.id)+1);
    }
    if([...uses.values()].some(count=>count<2))observedContextFail('unused_or_unshared_row');
  }
  delete view.observed_sound_contexts;return view;
}

function projectObservedSoundRoleInput(input){
  if(input.stage!=='current_research_episode_assembly'||input.data?.assembly_partition?.role!=='sounds'
    ||!input.data?.inline)return null;
  const originalView=expandBoundedInlineRecords(input.data.inline);
  if(originalView.assembly_sfx_pool_contract_revision!==observedPoolRevision)return null;
  if(input.data.observed_sound_context_encoding!==undefined||originalView.observed_sound_contexts!==undefined)
    observedContextFail('reserved_input_field');
  const view=structuredClone(originalView),table={revision:observedAssemblySoundContextRevision,
    sound_query_projections:[],sound_function_intents:[]},references=[];
  for(const [field,tableKey,prefix]of observedContextFields){
    const groups=new Map();
    for(const [index,candidate]of (view.candidates?.sounds??[]).entries()){
      if(Object.hasOwn(candidate,field+'_ref'))observedContextFail('reserved_input_reference');
      if(candidate.assembly_sfx_pool_contract_revision!==observedPoolRevision)continue;
      const value=candidate[field];if(!value||typeof value!=='object'||Array.isArray(value))continue;
      const key=canonical(value),group=groups.get(key)??{value,indexes:[]};
      group.indexes.push(index);groups.set(key,group);
    }
    for(const {value,indexes}of groups.values()){
      if(indexes.length<2)continue;
      const value_sha256=shaBytes(canonical(value)),id=prefix+value_sha256.slice(0,16);
      if(table[tableKey].some(row=>row.id===id))observedContextFail('id_collision');
      table[tableKey].push({id,value_sha256,value:structuredClone(value)});
      for(const index of indexes){const candidate=view.candidates.sounds[index];
        delete candidate[field];candidate[field+'_ref']=id;
        references.push({candidate_index:index,segment_id:candidate.segment_id,field,context_id:id,value_sha256});}
    }
    table[tableKey].sort((a,b)=>a.id.localeCompare(b.id));
  }
  if(!references.length)return null;
  view.observed_sound_contexts=table;
  if(canonical(expandObservedAssemblySoundContexts(view))!==canonical(originalView))
    observedContextFail('fact_roundtrip_changed');
  const projected=structuredClone(input),hostHash=shaBytes(canonical(input));
  projected.data.inline=encodeBoundedInlineRecords(view);
  projected.data.observed_sound_context_encoding={revision:observedAssemblySoundContextRevision,host_input_sha256:hostHash,
    instruction:'Expand inline shapes/strings first. Each sound_query_projection_ref/sound_function_intent_ref inherits the complete value from observed_sound_contexts matching id. All exclusions, unmatched constraints, original literals and intent remain binding; differing values are distinct. Source observations/probabilities are unchanged.'};
  return {input:projected,facts:structuredClone(input),audit:{revision:observedAssemblySoundContextRevision,
    complete_host_input_sha256:hostHash,shared_context_references:references,complete_inline_facts_roundtrip_equal:true,
    all_query_exclusions_intents_observations_and_constraints_preserved:true,qualification_granted:false}};
}
const recallOnlyFields = ['audio_retrieval_query', 'words_audio_retrieval_query', 'source_tag_queries', 'expert_ids'];
export function withOwnedPartClockBounds(original){
  const revision=original.data?.bounded_part_scope_revision;
  if(revision===undefined)return original;
  if(revision!==boundedPartScopeRevision)throw Error('bounded_part_scope_revision_invalid');
  const input=structuredClone(original),scope=input.data.assembly_partition,target=scope?.target_range;
  const actions=input.data.director?.music_actions??[];
  if(!Array.isArray(target)||target.length!==2||!target.every(Number.isFinite)||target[0]<0||target[1]<=target[0]
    ||!Array.isArray(scope.owned_action_ids)||!actions.length
    ||canonical(actions.map(action=>action.id))!==canonical(scope.owned_action_ids)
    ||actions.some(action=>!Array.isArray(action.target_range)||action.target_range[0]<target[0]||action.target_range[1]>target[1]))
    throw Error('bounded_part_complete_owned_interval_required');
  const piece=input.schema?.properties?.plan?.properties?.arcs?.items?.properties?.pieces?.items?.properties;
  if(piece?.target_range?.items?.type!=='number')throw Error('bounded_part_numeric_target_schema_required');
  if(piece.target_range.items.minimum>target[0]||piece.target_range.items.maximum<target[1])
    throw Error('bounded_part_original_target_schema_conflict');
  piece.target_range={...piece.target_range,items:{...piece.target_range.items,minimum:target[0],maximum:target[1]}};
  input.data.assembly_consumer_projection_revision=assemblyOwnedPartClockBoundsRevision;
  input.prompt+=' '+ownedPartClockInstruction(input);
  return input;
}
export function assertOwnedPartClockBounds(input){
  if(input.data?.bounded_part_scope_revision!==boundedPartScopeRevision
    ||input.data.assembly_consumer_projection_revision!==assemblyOwnedPartClockBoundsRevision)
    throw Error('bounded_part_explicit_scope_contract_required');
  const scope=input.data.assembly_partition,target=scope?.target_range;
  const item=input.schema?.properties?.plan?.properties?.arcs?.items?.properties?.pieces?.items?.properties?.target_range?.items;
  if(!Array.isArray(target)||target.length!==2||!target.every(Number.isFinite)||target[0]<0||target[1]<=target[0]
    ||item?.type!=='number'||item.minimum!==target[0]||item.maximum!==target[1]
    ||canonical(input.data.director.music_actions.map(action=>action.id))!==canonical(scope.owned_action_ids))
    throw Error('bounded_part_owned_interval_or_schema_changed');
  return true;
}
function ownedPartClockInstruction(input){
  const scope=input.data.assembly_partition;
  return 'Only this part target='+JSON.stringify(scope.target_range)+' and action_ids='+JSON.stringify(scope.owned_action_ids)
    +' are owned. Every piece.target_range endpoint stays inside that interval; cover its whole actions only. Episode duration, parent target and context_only routes/actions/beat clocks outside it are context, never permission to extend this part. Later parts own the remaining interval. Absolute source/target clocks remain unchanged. Every authored envelope point must keep base gain_db + relative gain_db within [-40,12] dB; use actual fade_out_seconds for a fade to silence, never an invalid -60 dB automation point.';
}
// Only the explicit mother-action view uses these additional host aliases.
// Keep every probability, sample clock, level, unknown and sound limitation inline.
function bindMotherSoundExecutionMetadata(current) {
  const data=current.input.data,aliases=current.audit.host_aliases;
  const move=(object,key,pointer,role)=>{
    if(!Object.hasOwn(object,key))return;
    aliases.push({pointer,role,value_sha256:shaBytes(canonical(object[key]))});delete object[key];
  };
  move(data,'bounded_assembly_projection_revision','/data/bounded_assembly_projection_revision','host_request_partition_revision');
  move(data,'bounded_assembly_continuation_revision','/data/bounded_assembly_continuation_revision','host_actual_tail_projection_revision');
  if(data.mother_action_partition)move(data.mother_action_partition,'instruction','/data/mother_action_partition/instruction','partition_rule_repeated_in_current_editing_instruction');
  for(const key of ['editor_source_measurements','editor_original_mix_measurements'])if(data[key])
    move(data[key],'revision','/data/'+key+'/revision','host_measurement_executor_revision');
  const selected=['music','words','sounds'].flatMap(kind=>data.candidates[kind]??[]);
  const unambiguous=row=>selected.filter(candidate=>candidate.segment_id===row.segment_id
    &&canonical(candidate.source_range)===canonical(row.source_range)).length===1;
  for(const kind of ['music','words','sounds'])for(const [index,row]of (data.candidates[kind]??[]).entries())
    if(unambiguous(row))for(const key of ['asset_id','source_sha256'])
      move(row,key,`/data/candidates/${kind}/${index}/${key}`,'selected_segment_and_window_unique_full_host_identity');
  for(const [index,row]of (data.editor_source_measurements?.rows??[]).entries())if(unambiguous(row))
    move(row,'source_sha256',`/data/editor_source_measurements/rows/${index}/source_sha256`,'unique_selected_window_measurement_identity');
  for(const [index,row]of (data.material_observations??[]).entries()){
    if(unambiguous(row))move(row,'source_sha256',`/data/material_observations/${index}/source_sha256`,'unique_selected_window_observation_identity');
    const observation=row.observation;
    if(!Array.isArray(observation?.specialist_predictions))continue;
    const pointer=`/data/material_observations/${index}/observation`;
    for(const [predictionIndex,prediction]of observation.specialist_predictions.entries()){
      const base=pointer+`/specialist_predictions/${predictionIndex}`;
      for(const key of ['model_revision','model_sha256','device'])move(prediction,key,base+'/'+key,'completed_sound_specialist_execution_metadata');
      if(prediction.scores&&canonical(Object.keys(prediction.scores).sort())===canonical(['path','sha256'])
        &&typeof prediction.scores.path==='string'&&/^[a-f0-9]{64}$/i.test(prediction.scores.sha256??''))
        move(prediction,'scores',base+'/scores','bound_score_file_identity_not_inline_probability_values');
      if(prediction.time_resolution&&canonical(prediction.time_resolution)===canonical(prediction.scope))
        move(prediction,'time_resolution',base+'/time_resolution','exact_duplicate_of_inline_specialist_scope');
      if(canonical(prediction.source_range)===canonical(row.source_range))
        move(prediction,'source_range',base+'/source_range','exact_duplicate_of_inline_observation_source_window');
    }
    if(canonical(observation.window_source_range)===canonical(row.source_range))
      move(observation,'window_source_range',pointer+'/window_source_range','exact_duplicate_of_inline_observation_source_window');
    for(const key of ['actual_clock','whole_recording_measurements'])
      if(observation[key]&&canonical(observation[key].source_range)===canonical(row.source_range))
        move(observation[key],'source_range',pointer+'/'+key+'/source_range','exact_duplicate_of_inline_observation_source_window');
  }
}
function table(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return rows;
  const columns = Object.keys(rows[0]);
  if (rows.some(row => canonical(Object.keys(row).sort()) !== canonical([...columns].sort()))) return rows;
  return { encoding: 'object-rows-v1', columns, rows: rows.map(row => columns.map(key => row[key])) };
}
function expandTable(value) {
  if (value?.encoding !== 'object-rows-v1') return value;
  if (!Array.isArray(value.columns) || !Array.isArray(value.rows) || new Set(value.columns).size !== value.columns.length
    || value.rows.some(row => !Array.isArray(row) || row.length !== value.columns.length)) throw Error('assembly_consumer_table_invalid');
  return value.rows.map(row => Object.fromEntries(value.columns.map((key, index) => [key, row[index]])));
}
function sequence(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.some(row => !row.before || !row.after)) return rows;
  return { encoding: 'sequence-condition-rows-v1', steps: table(rows.map((row, index) => ({ ...row, before: index * 2, after: index * 2 + 1 }))),
    states: table(rows.flatMap(row => [row.before, row.after])) };
}
function expandSequence(value) {
  if (value?.encoding !== 'sequence-condition-rows-v1') return value;
  const states = expandTable(value.states);
  return expandTable(value.steps).map(row => {
    if (!Number.isInteger(row.before) || !Number.isInteger(row.after) || !states[row.before] || !states[row.after])
      throw Error('assembly_consumer_sequence_reference_invalid');
    return { ...row, before: states[row.before], after: states[row.after] };
  });
}

export function expandAssemblyConsumerInput(input, { hostInput } = {}) {
  const expanded = structuredClone(input), data = expanded.data;
  if(data?.observed_sound_context_encoding!==undefined){
    const encoding=data.observed_sound_context_encoding;
    if(encoding.revision!==observedAssemblySoundContextRevision||!hostInput
      ||encoding.host_input_sha256!==shaBytes(canonical(hostInput)))observedContextFail('complete_host_input_required');
    expandObservedAssemblySoundContexts(expandBoundedInlineRecords(data.inline));
    const expected=projectObservedSoundRoleInput(hostInput);
    if(!expected||canonical(expected.input)!==canonical(input))observedContextFail('bound_projection_changed');
    return expected.facts;
  }
  if (!data?.assembly_consumer_encoding) return expanded;
  const encoding = data.assembly_consumer_encoding;
  if (editingRevisions.includes(encoding.revision)) {
    if (!hostInput || shaBytes(canonical(hostInput)) !== encoding.host_input_sha256)
      throw Error('assembly_consumer_complete_host_input_required');
    const expected = projectAssemblyConsumerInput(hostInput);
    if (canonical(expected.input) !== canonical(input)) throw Error('assembly_consumer_host_alias_changed');
    return expected.facts;
  }
  if (encoding.revision !== assemblyConsumerProjectionRevision) throw Error('assembly_consumer_projection_revision_invalid');
  data.analysis.story_beats = expandTable(data.analysis.story_beats);
  data.analysis.sound_events = expandTable(data.analysis.sound_events);
  for (const cue of data.director.cues) cue.story_sequence = expandSequence(cue.story_sequence);
  const constraints = data.editing_constraints;
  data.director.uncertainty_scopes = expandTable(data.director.uncertainty_scopes);
  data.director.uncertainty_dispositions = constraints.rows.map(([scopeIndex, parts]) => {
    const scope = data.director.uncertainty_scopes[scopeIndex];
    if (!scope) throw Error('assembly_consumer_uncertainty_reference_invalid');
    const original = (scope.origin === 'analysis' ? data.analysis : data.director).uncertainties?.[scope.uncertainty_index];
    if (typeof original !== 'string') throw Error('assembly_consumer_uncertainty_reference_invalid');
    return { origin: scope.origin, uncertainty_index: scope.uncertainty_index, original_text: original,
      source_video_sha256: data.source_video_sha256, components: parts.map(values => {
        if (values.length !== constraints.component_columns.length) throw Error('assembly_consumer_constraint_table_invalid');
        const part = Object.fromEntries(constraints.component_columns.map((key, index) => [key, values[index]]));
        const chars = Array.from(original);
        const range = part.text_range ?? [0, chars.length];
        part.text = chars.slice(...range).join(''); delete part.text_range;
        part.basis = part.basis.map(basis => {
          const beat = data.analysis.story_beats.find(row => row.id === basis.story_beat_id);
          const literal = beat?.[basis.field];
          if (typeof literal !== 'string') throw Error('assembly_consumer_basis_reference_invalid');
          const quote = basis.quote_range ? Array.from(literal).slice(...basis.quote_range).join('') : literal;
          const result = { ...basis, quote }; delete result.quote_range; return result;
        });
        part.condition_refs = part.condition_refs.map(ref => {
          const cue = data.director.cues.find(row => row.cue_id === ref.cue_id);
          if (!cue?.case_conditions) throw Error('assembly_consumer_condition_reference_invalid');
          return { ...ref, relationship: cue.case_conditions.relationship, threat_resolved: cue.case_conditions.threat_resolved };
        });
        return part;
      }) };
  });
  delete data.editing_constraints; delete data.assembly_consumer_encoding;
  return expanded;
}

export function projectAssemblyConsumerInput(input) {
  const sharedSound=projectObservedSoundRoleInput(input);
  if(sharedSound)return sharedSound;
  validateDiagnosticAssemblySoundPolicy(input);
  validateAssemblySoundFunctionContext(input);
  const projected=projectAssemblyConsumerInputBase(input);
  if(projected&&input.data?.diagnostic_sound_adoption_policy){
    if(!projected.input.prompt.includes(diagnosticAssemblySoundPrompt))projected.input.prompt+=' '+diagnosticAssemblySoundPrompt;
    projected.audit.diagnostic_sound_adoption_policy_revision=diagnosticAssemblySoundPolicyRevision;
  }
  if(projected&&input.data?.sfx_event_function_revision===sfxEventFunctionRevision){
    const prompt=soundFunctionPrompt(input);
    if(!projected.input.prompt.includes(prompt))projected.input.prompt+=' '+prompt;
    projected.audit.sfx_event_function_revision=sfxEventFunctionRevision;
  }
  return projected;
}
function projectAssemblyConsumerInputBase(input) {
  const revision = input.data?.assembly_consumer_projection_revision;
  if (revision !== undefined && !editingRevisions.includes(revision))
    throw Error('assembly_consumer_projection_revision_invalid');
  const legacy = projectAssemblyConsumerInputV1(input);
  if(legacy&&(revision===assemblyMotherActionEditingRevision||revision===assemblyOwnedPartClockBoundsRevision)){
    if(revision===assemblyOwnedPartClockBoundsRevision)assertOwnedPartClockBounds(input);
    if(revision===assemblyMotherActionEditingRevision&&(input.data?.bounded_assembly_projection_revision!=='mother-cue-complete-action-subparts-v1'||!input.data.mother_action_partition))
      throw Error('assembly_consumer_explicit_mother_action_partition_required');
    const current=projectCurrentEditingInput(input,legacy,assemblySoundOwnershipRevision);
    bindActualTailOperandView(current.input.data,current.audit.host_aliases);
    bindMotherSoundExecutionMetadata(current);
    current.input.prompt='ALL constraints/global parent route/conditions bind. Temporary aliases restore one parent arc. Edit owned whole actions/events; context_only unedited. Segment/window identities are host-bound. Piece source SUBRANGE stays inside admitted/library bounds, equals target 48k length; no mandatory full candidate use, invention or loop. Full coverage/actual connections/tail/gain smoothing; use exact RMS/peak/energy. Task=<cue_id>/arc/<arc_id>/<piece_id>. Actions retain whole ranges/task coverage; holds/actual operations match edits. Envelope=null or relative dB at 0/task end; automation anchor may null; dialogue duck 0..18. '
      +(input.data.candidates.sounds.length?'Sounds: one row/owned event. Unknown physical/Foley/environment omit/preserve. Optional dramatic/transition use supplied source/anchor. Ambience needs exact human review+verified_missing/insufficient, source anchor=0,target=start; bed supplied start/full event duration, no extension/transient substitution. ':'No sounds: one omit row/owned event, never []; preserve original/SFX unknowns. ')
      +(input.data.candidates.words.length?'Real /words: complete phrases/allowed intervals/boundaries; never trim or replace required lyrics. ':'No /words: optional explore/proposed target pending, require gap; music vocal/phrase unknown. ')
      +'Impossible required identity/coverage/phrase/edit=execution_gaps; compatible unknown development/audition/measurement/seam=review_pending. Gain/energy verifies no orchestration/phrase/meaning/attack; no approval.';
    if(revision===assemblyOwnedPartClockBoundsRevision){
      current.input.prompt=current.input.prompt.replace('Temporary aliases restore one parent arc. ',input.data.mother_action_partition?'Temporary aliases restore one parent arc. ':'')
        .replace('No /words: optional explore/proposed target pending, require gap; music vocal/phrase unknown. ',
          'No /words: explore without selected phrase is review_pending even with a proposed target; unavailable optional words alone never block valid music. Require/actual selected complete phrase remains hard; music vocal/phrase unknown. ')
        +' '+ownedPartClockInstruction(input);
    }
    delete current.input.data.assembly_consumer_encoding.host_input_sha256;
    delete current.input.data.assembly_consumer_encoding;
    const actualTail=current.input.data.actual_previous_assembly_tail;
    delete current.input.data.actual_previous_assembly_tail;
    const inline=encodeBoundedInlineRecords(current.input.data);
    if(canonical(expandBoundedInlineRecords(inline))!==canonical(current.input.data))throw Error('assembly_consumer_inline_roundtrip_changed');
    current.input.data={assembly_consumer_encoding:{revision,host_input_sha256:shaBytes(canonical(input)),
      instruction:'["~",i,...v] maps shapes[i]; ["~s",i] maps strings[i]. Rows map columns; sequence before/after index states. Constraints=[scope,components], kind_stage_index indexes kind_stage_pairs; ALL reasons/basis/condition_refs/retained_constraints bind, origin/index unresolved. Basis=beat field/Unicode quote_range; cue_ids=relationship/threat_resolved; route refs=inline cues. PCM uniform start=first+i*step, other end=next/final_source_end_seconds; exact clocks/values. Tail gain rows=[offset_seconds,gain_db], complete actual curve.'},inline,...(actualTail?{actual_previous_assembly_tail:actualTail}:{})};
    current.audit={...current.audit,revision,inline_record_roundtrip_equal:true};
    return current;
  }
  return legacy && editingRevisions.includes(revision) ? projectCurrentEditingInput(input, legacy, revision) : legacy;
}

// Keep the exact unmarked v1 view/audit readable by historical completed receipts.
export function projectAssemblyConsumerInputV1(input) {
  if (input.stage !== 'current_research_episode_assembly' || !Array.isArray(input.data?.analysis?.story_beats)
    || !Array.isArray(input.data?.director?.cues) || !Array.isArray(input.data?.director?.uncertainty_scopes)
    || !Array.isArray(input.data?.director?.uncertainty_dispositions)) return null;
  const projected = structuredClone(input), data = projected.data, omitted = [];
  const omit = (object, key, path, role) => { if (!Object.hasOwn(object, key)) return;
    omitted.push({ path, field_role: role, original_value_sha256: shaBytes(canonical(object[key])) }); delete object[key]; };
  for (const [index, cue] of data.director.cues.entries()) for (const key of recallOnlyFields)
    omit(cue, key, `/data/director/cues/${index}/${key}`, 'completed_material_recall_only');
  for (const key of ['full_input', 'bound_artifacts', 'completed_story', 'source_frame_mapping'])
    omit(data, key, `/data/${key}`, 'host_audit_identity_only_complete_facts_are_inline_and_full_request_retained');
  // Keep all local style/sound_decision text: it may contain binding exclusions,
  // source limitations or facts even when described as a hypothesis.
  // Even local sound decisions may contain binding prohibition/coverage rules;
  // retain their complete text rather than guessing which clauses are advice.
  for (const [index, observed] of (data.material_observations ?? []).entries()) {
    for (const [predictionIndex, prediction] of (observed.observation?.predictions ?? []).entries()) for (const key of ['model_revision', 'model_sha256'])
      omit(prediction, key, `/data/material_observations/${index}/observation/predictions/${predictionIndex}/${key}`, 'selected_recording_observer_execution_metadata_in_bound_record');
    for (const [pcmIndex, pcm] of (observed.observation?.input_pcm_by_backend ?? []).entries())
      omit(pcm, 'model_input_pcm_sha256', `/data/material_observations/${index}/observation/input_pcm_by_backend/${pcmIndex}/model_input_pcm_sha256`, 'observer_pcm_execution_identity_in_bound_record');
  }
  const constraints = { component_columns: ['text_range', 'kind', 'required_stage', 'reason', 'basis', 'condition_refs', 'retained_constraints'],
    rows: data.director.uncertainty_dispositions.map(disposition => {
      const scopeIndex = data.director.uncertainty_scopes.findIndex(scope => scope.origin === disposition.origin && scope.uncertainty_index === disposition.uncertainty_index);
      const original = (disposition.origin === 'analysis' ? data.analysis : data.director).uncertainties?.[disposition.uncertainty_index];
      if (scopeIndex < 0 || original !== disposition.original_text || disposition.source_video_sha256 !== data.source_video_sha256
        || disposition.components.map(part => part.text).join('') !== original) throw Error('assembly_consumer_original_uncertainty_mismatch');
      let position = 0;
      return [scopeIndex, disposition.components.map(part => {
        const length = Array.from(part.text).length, text_range = disposition.components.length === 1 ? null : [position, position + length]; position += length;
        const basis = part.basis.map(ref => {
          const beat = data.analysis.story_beats.find(row => row.id === ref.story_beat_id), value = beat?.[ref.field];
          if (typeof value !== 'string' || !value.includes(ref.quote)) throw Error('assembly_consumer_basis_reference_invalid');
          const result = { ...ref }; delete result.quote;
          if (value !== ref.quote) {
            const start = Array.from(value.slice(0, value.indexOf(ref.quote))).length;
            result.quote_range = [start, start + Array.from(ref.quote).length];
          }
          return result;
        });
        const refs = part.condition_refs.map(ref => {
          const cue = data.director.cues.find(row => row.cue_id === ref.cue_id);
          if (cue?.case_conditions.relationship !== ref.relationship || cue.case_conditions.threat_resolved !== ref.threat_resolved)
            throw Error('assembly_consumer_condition_reference_invalid');
          const result = { ...ref }; delete result.relationship; delete result.threat_resolved; return result;
        });
        return [text_range, part.kind, part.required_stage, part.reason, basis, refs, part.retained_constraints];
      })];
    }) };
  const facts = structuredClone(projected);
  delete data.director.uncertainty_dispositions;
  data.director.uncertainty_scopes = table(data.director.uncertainty_scopes);
  data.editing_constraints = constraints;
  data.analysis.story_beats = table(data.analysis.story_beats); data.analysis.sound_events = table(data.analysis.sound_events);
  for (const cue of data.director.cues) cue.story_sequence = sequence(cue.story_sequence);
  data.assembly_consumer_encoding = { revision: assemblyConsumerProjectionRevision,
    instruction: 'Rows map to columns. Sequence before/after integers index states. editing_constraints rows=[scope_index,component_rows]; scope origin/index names the unchanged analysis/director.uncertainties text. text_range=null=whole text, else Unicode[start,end). Basis quote=actual story_beat_id field (optional quote_range); condition refs=cue relationship/threat_resolved. All active constraints/facts/words/scores/clocks remain.' };
  if (canonical(expandAssemblyConsumerInput(projected)) !== canonical(facts)) throw Error('assembly_consumer_fact_roundtrip_changed');
  return { input: projected, facts, audit: { revision: assemblyConsumerProjectionRevision, full_input_sha256: shaBytes(canonical(input)),
    current_editing_facts_sha256: shaBytes(canonical(facts)), omitted_fields: omitted, omitted_values_retained_in_full_host_request: true,
    source_plot_words_scores_clocks_and_active_constraints_preserved: true, current_fact_roundtrip_equal: true, qualification_granted: false } };
}

const currentEditingPrompt = input => 'Arrange the complete ordered story and current director route under ALL editing_constraints; completed origin/index literals stay unknown, do not reclassify. '
  + 'One ordered arc per owned mother cue; preserve all actions/events, perspective, expectation and control changes. Context-only rows receive no edits. '
  + 'Only supplied candidates, unchanged selected bounds, distinct source/target clocks, equal durations at 48kHz, complete coverage and real connections; no invented source/loop/observation/selection. '
  + 'Task=<cue_id>/arc/<arc_id>/<piece_id>; /words requires real words input. Action responses retain full ranges and covering music_task_cue_ids. '
  + 'Requested hold only; other responses declare actual_edit_operation/real target anchor. Source switches change actual position; gain/envelope/accent operations exist in edits. '
  + 'Automation=null or relative dB points at zero/full duration. Continuation respects adopted previous tail, authored envelopes and continuous gain smoothing. '
  + 'Use exact asset/original RMS/peak/energy for audible gains, interior source starts, continuity, headroom and positive 0..18dB local dialogue attenuation. '
  + 'Energy proves no orchestration/phrase/meaning; coarse point probes prove no exact attack. Asset anchors are not target anchors. Source_development needs exact independent local facts or stays pending. '
  + ((input.data.candidates?.sounds ?? []).length
    ? 'Unknown physical/Foley/environment: omit and preserve original. Optional dramatic/transition: supplied candidate/unchanged anchor, at most one/event. '
      + 'Ambience: exact human original-event review plus verified_missing/verified_insufficient, source anchor zero, target anchor=start. '
      + 'Dramatic bed: supplied source start and exact full event duration; no extension. Bed cannot replace transient accent. '
    : 'No supplied sound candidate: every sound event must omit, preserving the original unknown physical/Foley/environment track and SFX risks. ')
  + ((input.data.candidates?.words ?? []).length
    ? 'Supplied words require their real /words track, full phrases, allowed intervals and boundary limits; do not substitute instrumental audio for required lyrics. '
    : 'No words candidate: no vocal/verified phrase; retain explored-word gap. ')
  + 'All persistent danger, physical unknown and SFX/words constraints remain binding. '
  + 'Unexecutable source/identity/coverage/phrase/editing problems: execution_gaps. Audition/prediction/measurement/phrase/seam/duplication limits: review_pending. '
  + 'edits.uncertainties=[], edits.schema_version=2. No hearing/semantic/production approval.';

// v2 is immutable: completed receipts bind its exact model view and prompt.
const editingPermissionsPrompt = (input, explicitSounds = false) => 'Arrange whole ordered story/director route under ALL editing_constraints; host literals stay unknown. '
  + 'One arc/owned mother; keep all actions/events, perspective/expectation/control changes. Context-only gets no edit. '
  + 'Only selected identities. candidate_source_range=availability, NOT mandatory full use: piece.source_range may be a SUBRANGE inside admitted candidate/source/library bounds; actual source/target durations alone match at 48kHz. Full coverage/connections; no invented source/loop/observation/selection. '
  + 'Task=<cue_id>/arc/<arc_id>/<piece_id>; /words needs real words. Actions keep full ranges/covering music_task_cue_ids. Requested hold stays hold. Other intents use real operands: switch/gain/envelope/accent/verified lyrics; actual_edit_operation matches edits. Envelope=null or relative dB points at 0/task end; whole-task automation may use anchor=null. '
  + 'Continue adopted tail/curves with smoothed gain. Exact RMS/peak/energy guide audible gain/interior starts/continuity/headroom; dialogue ducking positive 0..18dB. '
  + 'Energy/prediction proves no orchestration/phrase/meaning/exact attack. Asset anchors differ from target. Unverified source_development stays pending; executable gain/envelope needs/proves no instrumentation change. Specifically required unavailable operations remain gaps. '
  + ((input.data.candidates?.sounds ?? []).length
    ? 'Unknown physical/Foley/environment: omit/preserve. Optional dramatic/transition: supplied candidate/unchanged anchor, one/event. Ambience: exact human original-event review+verified_missing/insufficient, source anchor=0,target=start. Bed: supplied start/full event duration, no extension/transient substitution. '
    : explicitSounds ? 'No sounds: edits.sounds=one omit row/owned event, never []; preserve original/SFX unknowns. '
      : 'No sounds: omit every event, preserve original unknown physical/Foley/environment and SFX risks. ')
  + ((input.data.candidates?.words ?? []).length
    ? 'Real selected /words: whole phrases/allowed intervals/boundaries, never trim phrases or replace required lyrics with instrumental audio. '
    : 'No verified /words: explore (even proposed target) stays optional review_pending, no /words edit; require is execution gap. Music vocal/phrase unknown; do not certify instrumental. ')
  + 'Persistent danger/physical/SFX/words constraints bind. execution_gaps=actual impossible identity/coverage/required phrase/edit; review_pending=optional explore and unverified development/semantics/measurement/phrase/seam/audition that permit editing. '
  + 'edits.uncertainties=[],schema_version=2; no hearing/semantic/production approval.';

// v4 removes repeated instructions already explicit in the business schema,
// full constraint rows and encoding; its data/facts are identical to v3.
const explicitSoundOwnershipPrompt = input => 'ALL editing_constraints bind full ordered owned-cue story/actions/events/perspective/expectation/control; unknowns remain. Context-only unedited. '
  + 'candidate_source_range=availability, not mandatory use; piece.source_range=SUBRANGE inside candidate/source/library bounds. Source/target 48k lengths equal; selected identity/full coverage/real connections fixed; no invented source/loop/evidence. '
  + 'Task=<cue_id>/arc/<arc_id>/<piece_id>; actions keep full ranges/task coverage. Hold stays hold; other actual_edit_operation matches operands. '
  + 'Envelope=null or relative dB at 0/task end; whole automation permits anchor=null. Use actual tail/smoothed gain, exact RMS/peak/energy for audible gain/interior/headroom; dialogue duck 0..18dB. '
  + 'Gain needs/proves no orchestration; energy/prediction proves no phrase/meaning/attack. Unknown source_development pending; asset!=target anchor. '
  + ((input.data.candidates?.sounds ?? []).length
    ? 'Unknown physical/Foley/environment: omit/preserve. Optional dramatic/transition: supplied candidate/unchanged anchor, one/event. Ambience: exact human original-event review+verified_missing/insufficient, source anchor=0,target=start. Bed: supplied start/full event duration, no extension/transient substitution. Return one sound row per owned event. '
    : 'No sounds: edits.sounds=one omit row/owned event, never []; preserve original/SFX unknowns. ')
  + ((input.data.candidates?.words ?? []).length
    ? 'Real /words: whole phrases/allowed intervals/boundaries; never trim or replace required lyrics with instrumental audio. '
    : 'No /words: optional explore/proposed target=review_pending, no word edit; require=execution_gaps. Music vocal/phrase unknown. ')
  + 'execution_gaps=impossible required identity/coverage/phrase/edit; compatible unknowns/audition/measurement/seams=review_pending. No approval.';

function projectCurrentEditingInput(original, legacy, revision) {
  const output = structuredClone(legacy.input), data = output.data, hostAliases = [];
  const move = (object, key, pointer, role) => {
    if (!Object.hasOwn(object, key)) return;
    hostAliases.push({ pointer, role, value_sha256: shaBytes(canonical(object[key])) }); delete object[key];
  };
  if(data.diagnostic_sound_adoption_policy)move(data.diagnostic_sound_adoption_policy,'host_authorization',
    '/data/diagnostic_sound_adoption_policy/host_authorization','validated_diagnostic_authorization_in_complete_host_request');
  const mapping = [], refs = { analysis: [], direction: [] };
  // Only already classified literals can leave the model view. Unscoped or
  // unclassified unknowns remain verbatim, retaining their original indices.
  for (const [origin, source] of [['analysis', original.data.analysis], ['direction', original.data.director]]) {
    const inline = {};
    for (const [key, literal] of Object.entries(source.uncertainties ?? {})) {
      const index = Number(key), scopes = original.data.director.uncertainty_scopes
        .map((scope, position) => ({ scope, position })).filter(row => row.scope.origin === origin && row.scope.uncertainty_index === index);
      const dispositions = original.data.director.uncertainty_dispositions.filter(row => row.origin === origin && row.uncertainty_index === index);
      if (!scopes.length && !dispositions.length) { inline[key] = literal; continue; }
      if (scopes.length !== 1 || dispositions.length !== 1 || !dispositions[0].components?.length
        || dispositions[0].original_text !== literal || dispositions[0].source_video_sha256 !== original.data.source_video_sha256)
        throw Error('assembly_consumer_constraint_single_mapping_required');
      const rowIndexes = data.editing_constraints.rows.map((row, position) => ({ row, position }))
        .filter(row => row.row[0] === scopes[0].position);
      if (rowIndexes.length !== 1 || rowIndexes[0].row[1].length !== dispositions[0].components.length)
        throw Error('assembly_consumer_constraint_projection_missing');
      refs[origin].push(index);
      mapping.push({ origin, uncertainty_index: index, scope_index: scopes[0].position,
        projected_row_index: rowIndexes[0].position, original_text_sha256: shaBytes(canonical(literal)),
        complete_components_sha256: shaBytes(canonical(dispositions[0].components)),
        complete_scope_sha256: shaBytes(canonical(scopes[0].scope)), component_count: dispositions[0].components.length,
        original_pointer: `/data/${origin === 'analysis' ? 'analysis' : 'director'}/uncertainties/${key}` });
    }
    data[origin === 'analysis' ? 'analysis' : 'director'].uncertainties = inline;
  }
  if (mapping.length !== data.editing_constraints.rows.length)
    throw Error('assembly_consumer_constraint_projection_not_bijective');
  data.original_uncertainty_refs = refs;
  hostAliases.push({ pointer: '/prompt', role: 'complete_original_assembly_instruction', value_sha256: shaBytes(canonical(original.prompt)) });
  output.prompt = revision === assemblyEditingProjectionRevision ? currentEditingPrompt(original)
    : revision === assemblySoundOwnershipRevision ? explicitSoundOwnershipPrompt(original) : editingPermissionsPrompt(original);
  for (const key of ['status', 'request_id', 'schema_version', 'source_video_sha256'])
    move(data.analysis, key, `/data/analysis/${key}`, 'completed_analysis_execution_identity');
  for (const key of ['direction_version', 'source_video_sha256'])
    move(data.director, key, `/data/director/${key}`, 'completed_direction_execution_identity');
  move(data, 'projection_scope', '/data/projection_scope', 'host_projection_provenance');
  move(data, 'frame_policy', '/data/frame_policy', 'completed_story_and_frame_execution_provenance');
  move(data, 'assembly_consumer_projection_revision', '/data/assembly_consumer_projection_revision', 'revision_already_declared_in_current_encoding');
  for (const [index, row] of (data.material_observations ?? []).entries()) {
    for (const key of ['evidence', 'input_pcm_by_backend'])
      move(row.observation, key, `/data/material_observations/${index}/observation/${key}`, 'selected_observer_execution_metadata_in_complete_record');
    for (const [predictionIndex, prediction] of (row.observation.predictions ?? []).entries())
      for (const key of ['device']) move(prediction, key,
        `/data/material_observations/${index}/observation/predictions/${predictionIndex}/${key}`, 'selected_observer_execution_metadata_in_complete_record');
    for (const [predictionIndex, prediction] of (row.observation.predictions ?? []).entries())
      if (prediction.scope && canonical(prediction.scope) === canonical(prediction.time_resolution))
        move(prediction, 'time_resolution', `/data/material_observations/${index}/observation/predictions/${predictionIndex}/time_resolution`, 'exact_duplicate_of_inline_prediction_scope');
  }
  for (const kind of ['music', 'words', 'sounds']) for (const [index, row] of (data.candidates?.[kind] ?? []).entries())
    for (const key of ['pack_id', 'music_pack_id', 'window_id', 'preset_id', 'route_kind', 'offline_observation', 'observation_record', 'selection_record'])
      move(row, key, `/data/candidates/${kind}/${index}/${key}`, 'completed_selected_source_provenance_in_bound_host_candidate');
  data.director.music_actions = table(data.director.music_actions);
  if ((data.director.sound_queries ?? []).every(query =>
    !(original.data.candidates.sounds ?? []).some(row => row.event_id === query.event_id)
    && (original.data.sound_event_guidance ?? []).some(row => row.event_id === query.event_id && row.decision === 'omit'
      && row.selected_segment_id === null && row.selected_source_range === null)))
    move(data.director, 'sound_queries', '/data/director/sound_queries', 'completed_recall_only_no_candidate_and_binding_event_omission_inline');
  data.sound_event_guidance = table(data.sound_event_guidance);
  const pairs = [], lookup = new Map(), constraints = data.editing_constraints;
  for (const [, components] of constraints.rows) for (const component of components) {
    const pair = [component[1], component[2]], key = canonical(pair);
    if (!lookup.has(key)) { lookup.set(key, pairs.length); pairs.push(pair); }
    component.splice(1, 2, lookup.get(key));
    const conditionPosition = constraints.component_columns.indexOf('condition_refs') - 1;
    if (component[conditionPosition].every(ref => canonical(Object.keys(ref)) === canonical(['cue_id'])))
      component[conditionPosition] = { cue_ids: component[conditionPosition].map(ref => ref.cue_id) };
  }
  constraints.component_columns.splice(1, 2, 'kind_stage_index'); constraints.kind_stage_pairs = pairs;
  if (data.assembly_partition) {
    move(data.assembly_partition, 'instruction', '/data/assembly_partition/instruction', 'partition_rule_in_current_instruction');
    for (const key of ['revision', 'full_input_sha256', 'original_unknown_indices_preserved', 'original_timebase_unchanged'])
      move(data.assembly_partition, key, `/data/assembly_partition/${key}`, 'complete_partition_execution_provenance');
    const route = data.assembly_partition.complete_episode_route, cues = data.director.cues;
    if (route?.every(row => cues.some(cue => cue.cue_id === row.cue_id && !cue.context_only))) {
      move(data.assembly_partition, 'complete_episode_route', '/data/assembly_partition/complete_episode_route', 'complete_route_already_inline_in_owned_director_cues');
      data.assembly_partition.complete_episode_route_refs = route.map(row => row.cue_id);
    }
    const owned = data.assembly_partition.owned_cue_ids.map(id => cues.find(cue => cue.cue_id === id));
    if (owned.every(Boolean) && canonical(data.assembly_partition.target_range)
      === canonical([owned[0].target_range[0], owned.at(-1).target_range[1]]))
      move(data.assembly_partition, 'target_range', '/data/assembly_partition/target_range', 'exact_duplicate_of_owned_cue_route_endpoints');
  }
  // Adjacent exact PCM interval clocks occur twice. Store each start once and
  // the final endpoint, with a strict adjacency test; no rounding/resampling.
  for (const [index, row] of (data.editor_source_measurements?.rows ?? []).entries()) {
    const energies = row.source_energy_rows;
    if (Array.isArray(energies) && energies.length > 1 && energies.every((value, at) => Array.isArray(value) && value.length === 4
      && value.every(Number.isFinite) && value[1] > value[0] && (!at || energies[at - 1][1] === value[0]))) {
      row.source_energy_rows = { encoding: 'adjacent-exact-pcm-intervals-v1', final_source_end_seconds: energies.at(-1)[1],
        rows: energies.map(([start, , rms, peak]) => [start, rms, peak]) };
      if (row.source_energy_columns) {
        if (!Array.isArray(row.source_energy_columns) || row.source_energy_columns.length !== 4)
          throw Error('assembly_consumer_pcm_columns_invalid');
        hostAliases.push({ pointer: `/data/editor_source_measurements/rows/${index}/source_energy_columns`,
          role: 'lossless_adjacent_pcm_interval_columns', value_sha256: shaBytes(canonical(row.source_energy_columns)) });
        row.source_energy_columns = [row.source_energy_columns[0], row.source_energy_columns[2], row.source_energy_columns[3]];
      }
      hostAliases.push({ pointer: `/data/editor_source_measurements/rows/${index}/source_energy_rows`,
        role: 'lossless_adjacent_pcm_interval_encoding', value_sha256: shaBytes(canonical(energies)) });
    }
  }
  data.assembly_consumer_encoding = { revision, host_input_sha256: shaBytes(canonical(original)),
    instruction: 'Object rows map columns; sequence before/after indexes states. Constraint rows=[original scope index,components]; kind_stage_index indexes kind_stage_pairs. '
      + 'Origin/index host literals stay unresolved; ALL component reasons/basis/condition_refs/retained_constraints bind. Basis quote=beat field (+Unicode quote_range); condition cue_ids=actual cue relationship/threat_resolved. '
      + 'PCM rows=[exact start,RMS,peak], end=next start/final_source_end_seconds. Route refs=inline cues. No rounded clocks.' };
  const facts = structuredClone(legacy.facts);
  return { input: output, facts, audit: { ...legacy.audit, revision,
    legacy_revision: legacy.audit.revision, complete_host_input_sha256: shaBytes(canonical(original)),
    host_aliases: hostAliases, original_constraint_mapping: mapping, constraint_mapping_bijective: true,
    classified_literal_count: mapping.length, unclassified_literals_retained_verbatim: true,
    current_editing_components_unchanged: true, all_plot_actions_sources_measurements_and_active_constraints_preserved: true,
    complete_facts_require_bound_host_input_to_expand: true, qualification_granted: false } };
}
