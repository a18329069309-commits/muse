import path from 'node:path';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const fail = reason => { throw new Error(`direction_projection_${reason}`); };
const instruction = '\nInput tables use columns and rows; observation windows inherit research_observation_metadata[metadata_ref]. Local style_direction suggestions are archived for audit; plan the whole episode from all plot facts, events, unknowns and transcripts. Return original IDs and schema fields.';
const windowKeys = ['source_range', 'transcription_prediction', 'dialogue_activity_prediction'];
const extraKeys = ['research_observation_metadata', 'archived_local_style_suggestions', 'input_projection'];

function table(rows) {
  if (!Array.isArray(rows)) return rows;
  const columns = Object.keys(rows[0] ?? {});
  if (rows.some(row => canonical(Object.keys(row).sort()) !== canonical([...columns].sort()))) return rows;
  return { columns, rows: rows.map(row => columns.map(key => row[key])) };
}

function expandTable(value) {
  if (Array.isArray(value) || value === null) return value;
  if (!Array.isArray(value?.columns) || !Array.isArray(value.rows)
    || new Set(value.columns).size !== value.columns.length || value.rows.some(row => !Array.isArray(row) || row.length !== value.columns.length)) fail('table_invalid');
  return value.rows.map(row => Object.fromEntries(value.columns.map((key, i) => [key, row[i]])));
}

// Only input representation changes. Unapproved per-part music suggestions are preserved in a bound archive.
export async function createDirectionInputProjection({ input, directory }) {
  if (input.stage !== 'research_style_director' || !input.data?.analysis?.style_direction
    || extraKeys.some(key => Object.hasOwn(input.data, key))) fail('whole_global_input_required');
  const fullInput = await saveJson(path.join(directory, 'full-input.json'), input);
  const localSuggestions = await saveJson(path.join(directory, 'local-style-suggestions.json'), {
    schema_version: 1, kind: 'unapproved_provisional_local_style_suggestions',
    source_video_sha256: input.data.source_video_sha256, analysis_request_id: input.data.analysis.request_id,
    style_direction: input.data.analysis.style_direction, artistic_approval: false, production_approval: false,
  });
  const projected = structuredClone(input), data = projected.data;
  delete data.analysis.style_direction;
  data.analysis.story_beats = table(data.analysis.story_beats);
  data.analysis.sound_events = table(data.analysis.sound_events);
  data.dialogue_intervals = table(data.dialogue_intervals);
  const observations = data.unqualified_research_observations;
  if (Array.isArray(observations) && observations.every(row => row.value && windowKeys.every(key => Object.hasOwn(row.value, key)))) {
    const metadata = [], indexes = new Map();
    data.unqualified_research_observations = observations.map(row => {
      const common = Object.fromEntries(Object.entries(row.value).filter(([key]) => !windowKeys.includes(key))), identity = canonical(common);
      if (!indexes.has(identity)) { indexes.set(identity, metadata.length); metadata.push(common); }
      const { value, ...rest } = row;
      return { ...rest, metadata_ref: indexes.get(identity), window: Object.fromEntries(windowKeys.map(key => [key, value[key]])) };
    });
    data.research_observation_metadata = metadata;
  }
  data.archived_local_style_suggestions = localSuggestions;
  data.input_projection = { revision: 'global-direction-tables-v1', full_input: fullInput };
  projected.prompt += instruction;
  await verifyDirectionInputProjection(projected);
  return { input: projected, full_input: fullInput, local_suggestions: localSuggestions };
}

export async function verifyDirectionInputProjection(input) {
  if (!input.data?.input_projection) return structuredClone(input);
  if (input.data.input_projection.revision !== 'global-direction-tables-v1' || !input.prompt.endsWith(instruction)) fail('contract_changed');
  for (const binding of [input.data.input_projection.full_input, input.data.archived_local_style_suggestions])
    if (!binding?.path || !path.isAbsolute(binding.path) || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? '')) fail('explicit_attachment_binding_required');
  await verifyEvidenceBindings([input.data.input_projection.full_input, input.data.archived_local_style_suggestions]);
  const original = await readJson(input.data.input_projection.full_input.path), archive = await readJson(input.data.archived_local_style_suggestions.path);
  if (archive.kind !== 'unapproved_provisional_local_style_suggestions' || archive.artistic_approval !== false || archive.production_approval !== false
    || archive.source_video_sha256 !== original.data.source_video_sha256 || archive.analysis_request_id !== original.data.analysis.request_id
    || canonical(archive.style_direction) !== canonical(original.data.analysis.style_direction)) fail('local_suggestions_archive_changed');
  const restored = structuredClone(input), data = restored.data;
  data.analysis.story_beats = expandTable(data.analysis.story_beats);
  data.analysis.sound_events = expandTable(data.analysis.sound_events);
  data.dialogue_intervals = expandTable(data.dialogue_intervals);
  if (data.research_observation_metadata) data.unqualified_research_observations = data.unqualified_research_observations.map(row => {
    const metadata = data.research_observation_metadata[row.metadata_ref];
    if (!metadata || !row.window || canonical(Object.keys(row.window).sort()) !== canonical([...windowKeys].sort())) fail('observation_reference_invalid');
    const { metadata_ref, window, ...rest } = row;
    return { ...rest, value: { ...metadata, ...window } };
  });
  data.analysis.style_direction = archive.style_direction;
  for (const key of extraKeys) delete data[key];
  restored.prompt = restored.prompt.slice(0, -instruction.length);
  if (canonical(restored) !== canonical(original)) fail('hydration_not_equal_original');
  await verifyEvidenceBindings(original);
  return restored;
}
