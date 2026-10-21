import path from 'node:path';
import { readJson, saveJson, shaBytes, objectSchema, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { projectCompactBusinessContract, restoreCompactBusinessValue, compactBusinessRevision } from './compact_business_contract.mjs';
import { decodeStyleRepairAnalysis } from './style_uncertainty_repair.mjs';
import { hashFile } from './render_binding.mjs';
import { directionSemanticGaps } from './direction_semantics.mjs';

export const directionSchemaRepairRevision = 'direction-missing-condition-fields-v1';
export const directionSchemaRepairStage = 'research_style_schema_missing_fields_repair';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const allowed = /^\/cues\/\d+\/(?:case_conditions|exclude_case_conditions\/\d+|story_sequence\/\d+\/(?:before|after))\/(?:relationship|threat_resolved)$/;

// The patch can only add absent required condition leaves. Existing judgments,
// cue timing, event IDs, uncertainty decisions and every other value stay frozen.
export function missingDirectionConditionFields(value, schema) {
  const missing = [];
  function visit(item, node, pointer = '') {
    if (!node || typeof node !== 'object') return;
    if ((Array.isArray(node.type) ? node.type : [node.type]).includes('object') && item && typeof item === 'object' && !Array.isArray(item)) {
      for (const key of node.required ?? []) if (!Object.hasOwn(item, key)) {
        const location = `${pointer}/${key}`;
        if (!allowed.test(location)) throw Error('direction_schema_repair_non_condition_missing_field');
        missing.push({ field_id: `field_${String(missing.length + 1).padStart(3, '0')}`, path: location,
          schema: structuredClone(node.properties[key]) });
      }
      for (const [key, child] of Object.entries(item)) if (node.properties?.[key]) visit(child, node.properties[key], `${pointer}/${key}`);
    }
    if ((Array.isArray(node.type) ? node.type : [node.type]).includes('array') && Array.isArray(item))
      item.forEach((child, index) => visit(child, node.items, `${pointer}/${index}`));
  }
  visit(value, schema);
  if (!missing.length) throw Error('direction_schema_repair_missing_conditions_required');
  return missing;
}

export function mergeDirectionSchemaRepair(firstWire, patch, contract, fields) {
  const patchSchema = objectSchema(Object.fromEntries(fields.map(row => [row.field_id, row.schema])));
  validateSchema(patch, patchSchema);
  const original = JSON.parse(firstWire.business_json), changed = structuredClone(original);
  for (const row of fields) {
    const keys = row.path.slice(1).split('/'), field = keys.pop();
    const parent = keys.reduce((value, key) => value?.[key], changed);
    if (!parent || Object.hasOwn(parent, field) || !allowed.test(row.path)) throw Error('direction_schema_repair_existing_field_immutable');
    parent[field] = patch[row.field_id];
  }
  const withoutAdditions = structuredClone(changed);
  for (const row of fields) {
    const keys = row.path.slice(1).split('/'), field = keys.pop();
    delete keys.reduce((value, key) => value[key], withoutAdditions)[field];
  }
  if (canonical(original) !== canonical(withoutAdditions)) throw Error('direction_schema_repair_frozen_values_changed');
  return restoreCompactBusinessValue({ business_json: JSON.stringify(changed) }, contract);
}

export async function createDirectionSchemaRepair({ failedReceipt, directory }) {
  await verifyEvidenceBindings(failedReceipt);
  const failed = await readJson(failedReceipt.path);
  await verifyEvidenceBindings([failed.request, failed.final, failed.host_business_contract]);
  const request = await readJson(failed.request.path), first = await readJson(failed.final.path), input = request.input;
  if (failed.status !== 'schema_invalid' || failed.exit_code !== 0 || failed.process_terminated !== true
    || input?.stage !== 'research_style_director' || failed.source_video_sha256 !== input.data?.source_video_sha256
    || failed.request_sha256 !== shaBytes(canonical(request)) || typeof first.business_json !== 'string')
    throw Error('direction_schema_repair_completed_bound_failure_required');
  const archivedContract = await readJson(failed.host_business_contract.path), contract = projectCompactBusinessContract(input);
  if (archivedContract.revision !== compactBusinessRevision || canonical(archivedContract) !== canonical(contract.audit))
    throw Error('direction_schema_repair_original_contract_changed');
  validateSchema(first, contract.wireSchema);
  const originalBusiness = JSON.parse(first.business_json), fields = missingDirectionConditionFields(originalBusiness, contract.businessSchema);
  // Reject malformed types/extra fields as distinct failures before an account call.
  // Temporary placeholders check only structure; never persist or publish them as facts.
  const structuralProbe = structuredClone(originalBusiness);
  for (const row of fields) {
    const keys = row.path.slice(1).split('/'), key = keys.pop();
    keys.reduce((value, part) => value[part], structuralProbe)[key] = row.schema.type?.includes?.('null') ? null
      : row.path.endsWith('/relationship') ? 'structure-only-placeholder' : false;
  }
  validateSchema(structuralProbe, contract.businessSchema);
  let analysis = input.data.analysis, storyBinding = input.data.completed_story;
  if (storyBinding) {
    await verifyEvidenceBindings(storyBinding);
    const story = await readJson(storyBinding.path); analysis = story.value ?? story;
  }
  analysis = decodeStyleRepairAnalysis(analysis);
  if (analysis?.source_video_sha256 !== input.data.source_video_sha256)
    throw Error('direction_schema_repair_analysis_source_mismatch');
  const schema = objectSchema(Object.fromEntries(fields.map(row => [row.field_id, row.schema])));
  const context = { revision: directionSchemaRepairRevision, failed_receipt: failedReceipt,
    original_request: failed.request, original_wire_final: failed.final, original_business_sha256: shaBytes(canonical(originalBusiness)),
    missing_fields: fields, original_contract: failed.host_business_contract,
    model_must_supply_all_values: true, only_missing_fields_inserted: true, production_approval: false };
  const contextPath = path.join(directory, 'missing-condition-context.json');
  let contextBinding;
  try { contextBinding = await saveJson(contextPath, context); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (canonical(await readJson(contextPath)) !== canonical(context)) throw Error('direction_schema_repair_context_changed');
    contextBinding = { path: path.resolve(contextPath), sha256: await hashFile(contextPath) };
  }
  const repairInput = { stage: directionSchemaRepairStage, frames: [], schema,
    prompt: 'This is one narrow schema repair of a completed direction. Return only the required typed field IDs. '
      + 'Infer relationship and threat state from the actual story and the unchanged cue/state at each specified path. '
      + 'Only uncertainty_dispositions.components.condition_refs omit these values for host restoration. '
      + 'All cue case_conditions, exclude_case_conditions and story_sequence before/after conditions require them. '
      + 'Do not alter timing, music choices, unknown reasons or any existing field. Never claim audio listening or approval. '
      + 'Null is allowed only where the typed schema permits it and genuinely unknown; do not invent confirmed kinship or resolved danger.',
    data: { source_video_sha256: input.data.source_video_sha256, execution_mode: input.data.execution_mode ?? input.data.mode,
      direction_schema_repair: contextBinding,
      analysis: { source_video_sha256: analysis.source_video_sha256, story_beats: analysis.story_beats,
        sound_events: analysis.sound_events, uncertainties: analysis.uncertainties, original_audio: analysis.original_audio },
      completed_story: storyBinding, direction_context: { global_route_summary: originalBusiness.global_route_summary,
        cues: originalBusiness.cues, uncertainties: originalBusiness.uncertainties },
      missing_fields: fields.map(({ field_id, path }) => ({ field_id, path })) } };
  return { input: repairInput, context, contextBinding, originalInput: input, first, contract, fields,
    knownGaps: directionSemanticGaps(originalBusiness, analysis),
    bindings: [failedReceipt, failed.request, failed.final, failed.host_business_contract, contextBinding,
      ...(storyBinding ? [storyBinding] : [])] };
}
