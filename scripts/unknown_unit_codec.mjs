import { createHash } from 'node:crypto';

// Pure, opt-in wire codec. Nothing imports this from a live runtime yet.
// Callers retain the host catalog AND binding from the immutable request;
// neither may be taken from the model response. Transport validity does not
// validate a classification or approve audio. Run the existing direction
// semantic validator after restoring the other host-owned evidence references.
export const unknownUnitCodecRevision = 'host-bound-unknown-units-v1';
export const unknownUnitSegmentationRevision = 'literal-punctuation-units-v1';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : row);
const digest = value => sha(canonical(value));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = reason => { throw Error('unknown_unit_' + reason); };
const key = row => `${row.origin}/${row.uncertainty_index}`;
const judgments = ['kind', 'required_stage', 'reason', 'basis', 'condition_refs', 'retained_constraints'];
function exactKeys(value, keys, reason) {
  if (!record(value) || Object.keys(value).length !== keys.length || keys.some(name => !Object.hasOwn(value, name))) fail(reason);
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function parentIdentity(row) {
  if (!['analysis', 'direction'].includes(row?.origin) || !Number.isSafeInteger(row.uncertainty_index) || row.uncertainty_index < 0)
    fail('parent_identity_invalid');
}

// Lexical delimiters only, never a semantic classification. Delimiters and
// whitespace are retained exactly. A requested boundary inside a unit is an
// explicit refinement gap, not permission to guess/clamp a character offset.
function literalUnits(text) {
  const parts = text.match(/[^。！？；，、,.!?;\r\n]+[。！？；，、,.!?;\r\n]*|[。！？；，、,.!?;\r\n]+/gu) ?? [];
  if (parts.join('') !== text) fail('segmentation_not_lossless');
  return parts;
}

export function buildUnknownUnitCatalog({ source_video_sha256, parent_input_sha256, items }) {
  if (!hash(source_video_sha256) || !hash(parent_input_sha256)) fail('host_identity_required');
  if (!Array.isArray(items)) fail('items_required');
  const seenParents = new Set(), seenUnits = new Set();
  const parents = items.map(item => {
    exactKeys(item, ['origin', 'uncertainty_index', 'text'], 'item_shape_invalid'); parentIdentity(item);
    if (seenParents.has(key(item))) fail('parent_duplicate'); seenParents.add(key(item));
    if (typeof item.text !== 'string' || !item.text.trim() || !item.text.isWellFormed()) fail('original_text_invalid');
    const text_sha256 = sha(item.text);
    const identity = { revision: unknownUnitCodecRevision, segmentation_revision: unknownUnitSegmentationRevision,
      source_video_sha256, parent_input_sha256, origin: item.origin, uncertainty_index: item.uncertainty_index, text_sha256 };
    let end = 0;
    const units = literalUnits(item.text).map((text, ordinal) => {
      const start = end; end += Array.from(text).length;
      const text_range = [start, end], unit_id = 'u_' + digest({ ...identity, ordinal, text, text_range }).slice(0, 24);
      if (seenUnits.has(unit_id)) fail('id_collision'); seenUnits.add(unit_id);
      return { unit_id, ordinal, text, text_range };
    });
    return { origin: item.origin, uncertainty_index: item.uncertainty_index, text: item.text, text_sha256, units };
  });
  const catalog = { revision: unknownUnitCodecRevision, segmentation_revision: unknownUnitSegmentationRevision,
    source_video_sha256, parent_input_sha256, parents };
  return freeze({ catalog, binding: { revision: unknownUnitCodecRevision, source_video_sha256, parent_input_sha256,
    catalog_sha256: digest(catalog) } });
}

function checkedHost(host) {
  exactKeys(host, ['catalog', 'binding'], 'host_catalog_and_binding_required');
  const { catalog, binding } = host;
  if (!record(catalog) || !Array.isArray(catalog.parents) || !record(binding)) fail('host_catalog_and_binding_required');
  const rebuilt = buildUnknownUnitCatalog({ source_video_sha256: catalog.source_video_sha256, parent_input_sha256: catalog.parent_input_sha256,
    items: catalog.parents.map(row => ({ origin: row.origin, uncertainty_index: row.uncertainty_index, text: row.text })) });
  if (canonical(catalog) !== canonical(rebuilt.catalog) || canonical(binding) !== canonical(rebuilt.binding)) fail('host_binding_changed');
  return catalog;
}

export function projectUnknownUnitCatalog(host) {
  const catalog = checkedHost(host);
  return {
    revision: unknownUnitCodecRevision,
    items: catalog.parents.map(row => ({ origin: row.origin, uncertainty_index: row.uncertainty_index,
      units: row.units.map(({ unit_id, text }) => ({ unit_id, text })) })),
    unit_ids_schema: { type: 'array', minItems: 1, items: { type: 'string', enum: catalog.parents.flatMap(row => row.units.map(unit => unit.unit_id)) } },
    instruction: 'Classify each original global origin/index once. Each component selects consecutive unit_ids from that same item in original order. '
      + 'Across components use every unit exactly once, with no gaps, repeats or reordering. Preserve all mixed meanings and all constraints. '
      + 'Do not count characters or output text/text_range/original_text/source identity. The host restores the identical original text. '
      + 'An indivisible mixed unit needs explicit host refinement; do not merge conflicting meanings or claim approval to force a result. '
      + 'This table grants no factual, sound, use or production qualification.',
  };
}

function selectedParents(rows, catalog, format) {
  if (!Array.isArray(rows) || rows.length !== catalog.parents.length) fail('parent_coverage_required');
  const parents = new Map(catalog.parents.map(row => [key(row), row])), seen = new Set();
  return rows.map(row => {
    exactKeys(row, format === 'text' ? ['origin', 'uncertainty_index', 'original_text', 'source_video_sha256', 'components']
      : ['origin', 'uncertainty_index', 'components'], 'disposition_shape_invalid');
    parentIdentity(row);
    const parent = parents.get(key(row));
    if (!parent || seen.has(key(row))) fail('parent_identity_or_duplicate'); seen.add(key(row));
    if (!Array.isArray(row.components) || !row.components.length) fail('components_required');
    if (format === 'text' && (row.original_text !== parent.text || row.source_video_sha256 !== catalog.source_video_sha256)) fail('original_identity_changed');
    return parent;
  });
}

// Only valid, already resolved textual components can be encoded. This is NOT
// a repair function for invalid old ranges: no offsets are accepted here.
export function encodeUnknownUnitDispositions(dispositions, host) {
  const catalog = checkedHost(host), parents = selectedParents(dispositions, catalog, 'text');
  return dispositions.map((row, rowIndex) => {
    const parent = parents[rowIndex]; let next = 0;
    const components = row.components.map(component => {
      exactKeys(component, ['text', ...judgments], 'component_shape_invalid');
      if (typeof component.text !== 'string' || !component.text.length) fail('component_text_required');
      let joined = ''; const unit_ids = [];
      while (next < parent.units.length && joined.length < component.text.length) {
        const unit = parent.units[next++]; joined += unit.text; unit_ids.push(unit.unit_id);
      }
      if (joined !== component.text) fail('refinement_required');
      const { text, ...judgment } = component; return { ...structuredClone(judgment), unit_ids };
    });
    if (next !== parent.units.length || row.components.map(component => component.text).join('') !== parent.text) fail('coverage_required');
    return { origin: row.origin, uncertainty_index: row.uncertainty_index, components };
  });
}

export function restoreUnknownUnitDispositions(dispositions, host) {
  const catalog = checkedHost(host), parents = selectedParents(dispositions, catalog, 'ids');
  const compact = [], decoded = dispositions.map((row, rowIndex) => {
    const parent = parents[rowIndex], ownIds = new Set(parent.units.map(unit => unit.unit_id)); let next = 0;
    const compactComponents = [];
    const components = row.components.map(component => {
      exactKeys(component, ['unit_ids', ...judgments], 'component_shape_invalid');
      if (!Array.isArray(component.unit_ids) || !component.unit_ids.length) fail('ids_required');
      const selected = component.unit_ids.map(id => {
        if (typeof id !== 'string' || !ownIds.has(id)) fail('reference_wrong_parent');
        const expected = parent.units[next++];
        if (!expected || expected.unit_id !== id) fail('reference_order_or_coverage');
        return expected;
      });
      const { unit_ids, ...judgment } = component, copy = structuredClone(judgment);
      compactComponents.push({ ...structuredClone(copy), text_range: [selected[0].text_range[0], selected.at(-1).text_range[1]] });
      return { ...copy, text: selected.map(unit => unit.text).join('') };
    });
    if (next !== parent.units.length || components.map(component => component.text).join('') !== parent.text) fail('coverage_required');
    compact.push({ origin: row.origin, uncertainty_index: row.uncertainty_index, components: compactComponents });
    return { origin: row.origin, uncertainty_index: row.uncertainty_index, original_text: parent.text,
      source_video_sha256: catalog.source_video_sha256, components };
  });
  return { dispositions: decoded, compact_dispositions: compact, audit: {
    revision: unknownUnitCodecRevision, ...structuredClone(host.binding),
    source_text_unchanged: true, classification_fields_changed: false, semantic_validation_performed: false,
    qualification_granted: false, factual_approval: false, production_approval: false, new_model_calls: 0,
  } };
}
