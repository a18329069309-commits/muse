import path from 'node:path';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

export const boundAssemblyGapRuntimeRevision = 'diagnostic-only-gap-classification-v1';
export const boundAssemblyGapStage = 'diagnostic_assembly_gap_fields_v1';
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('bound_assembly_gap_runtime_' + reason); };
const fields = ['manifest', 'analysis', 'director', 'evidence_catalog', 'candidates',
  'current_materials', 'case_routes', 'music_source_provenance'];

export function boundAssemblyGapRuntimeSpec(runtime, sourceSha) {
  const spec = runtime.boundedAssemblyGapClassifications?.[sourceSha];
  if (spec === undefined) return null;
  if (spec?.revision !== boundAssemblyGapRuntimeRevision
    || ['caller', 'preflight', 'part'].some(key => !path.isAbsolute(spec[key]?.path ?? '')
      || !/^[a-f0-9]{64}$/.test(spec[key]?.sha256 ?? '')))
    fail('explicit_source_bound_spec_required');
  return spec;
}

export function boundAssemblyGapStageOptions(runtime, sourceSha, options = {}) {
  const limits = runtime.stageRepairLimits ?? options.stageRepairLimits ?? {};
  const reasoning = runtime.stageReasoningEffort ?? options.stageReasoningEffort ?? {};
  if (!boundAssemblyGapRuntimeSpec(runtime, sourceSha))
    return {stageRepairLimits:limits,stageReasoningEffort:reasoning};
  if (Object.hasOwn(limits,boundAssemblyGapStage) && limits[boundAssemblyGapStage] !== 0
    || Object.hasOwn(reasoning,boundAssemblyGapStage) && reasoning[boundAssemblyGapStage] !== 'low')
    fail('classification_low_zero_repair_required');
  return {stageRepairLimits:{...limits,[boundAssemblyGapStage]:0},
    stageReasoningEffort:{...reasoning,[boundAssemblyGapStage]:'low'}};
}

// A completed, material-bound diagnostic part may be resumed without invoking
// the newly installed material producer. This is reuse of its old execution,
// never evidence that a new selector/policy has executed or passed.
export async function preflightBoundAssemblyGapControllerRecovery(spec, { config, source, state }) {
  if (config.mode !== 'research' || config.automatic_trial !== true
    || config.material_strategy !== 'independent_music_packs'
    || config.source_policy?.kind !== 'independent_pack_trial'
    || config.trial_review_policy !== 'diagnostic_candidates'
    || config.quality_review_policy !== 'diagnostic_only') fail('explicit_diagnostic_scope_required');
  if (spec?.revision !== boundAssemblyGapRuntimeRevision || state.source?.sha256 !== source.sha256)
    fail('source_or_revision_changed');
  const materials = state.stages?.materials, assembly = state.stages?.assembly;
  if (materials?.status !== 'completed' || assembly?.status !== 'waiting'
    || assembly.result?.status !== 'research_assembly_execution_gap'
    || !assembly.result.execution_gaps?.length || !path.isAbsolute(assembly.directory ?? '')
    || path.resolve(path.dirname(spec.caller.path)) !== path.resolve(assembly.directory))
    fail('bound_completed_materials_and_terminal_part_required');
  await verifyEvidenceBindings([source, materials.result_binding, assembly.result_binding, spec.caller, spec.preflight, spec.part]);
  if (!same(await readJson(materials.result_binding.path), materials.result)
    || !same(await readJson(assembly.result_binding.path), assembly.result)) fail('checkpoint_result_changed');
  const prepared = materials.result.prepared_assembly_config;
  const inputs = Object.fromEntries(fields.map(key => [key, prepared?.[key]]));
  if (fields.some(key => !inputs[key])) fail('complete_frozen_material_inputs_required');
  await verifyEvidenceBindings(inputs);
  const { researchAssemblySchema } = await import('./assemble_research_episode.mjs');
  const { preflightBoundAssemblyGapClassificationRecovery } = await import('./bounded_assembly_gap_classification.mjs');
  const proof = await preflightBoundAssemblyGapClassificationRecovery(spec,
    { inputs, schema: researchAssemblySchema(config), source });
  return { spec, proof, inputs, materials_result: materials.result_binding,
    source_sha256: source.sha256, completed_material_execution_reused: true,
    new_material_policy_executed: false, qualification_granted: false, production_approval: false };
}

export function preserveBoundAssemblyMaterialIdentity(previous, requested) {
  // Only an installed producer implementation may differ during a strictly
  // bound old-part continuation. A changed model, runtime policy, observer,
  // catalogue, source evidence or material store is not a cache hit.
  const withoutProducer = value => Object.fromEntries(Object.entries(value ?? {})
    .filter(([key]) => key !== 'sound_bridge_sha256'));
  if (!previous || !same(withoutProducer(previous), withoutProducer(requested)))
    fail('material_runtime_semantics_changed');
  return previous;
}
