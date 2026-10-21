// Lossless transport of accumulated continuity notes. This is dictionary coding,
// not a summary: every character, note boundary and order is reconstructible.
export function decodeContinuationLiteralParts(value) {
  if (value?.encoding !== 'literal_parts_v1') return value;
  if (!Array.isArray(value.dictionary) || value.dictionary.some(item => typeof item !== 'string' || !item.length)
    || !Array.isArray(value.rows) || value.rows.some(row => !Array.isArray(row)
      || row.some(item => typeof item !== 'string' && (!Number.isInteger(item) || item < 0 || item >= value.dictionary.length))))
    throw Error('story_continuation_literal_parts_invalid');
  return value.rows.map(row => row.map(item => typeof item === 'string' ? item : value.dictionary[item]).join(''));
}

export function encodeContinuationLiteralParts(values) {
  if (!Array.isArray(values) || values.length < 2 || values.some(value => typeof value !== 'string')) return null;
  let rows = values.map(value => [value]); const dictionary = [];
  for (let iteration = 0; iteration < 32; iteration++) {
    const candidates = new Map();
    for (const row of rows) for (const part of row) {
      if (typeof part !== 'string') continue;
      const characters = Array.from(part);
      for (let length = 4; length <= Math.min(64, characters.length); length++) {
        if (characters.length < length) continue;
        for (let start = 0; start <= characters.length - length; start++) {
          const fragment = characters.slice(start, start + length).join('');
          candidates.set(fragment, (candidates.get(fragment) ?? 0) + 1);
        }
      }
    }
    let best = null;
    for (const [fragment, possible] of candidates) {
      if (possible < 2) continue;
      let occurrences = 0;
      for (const row of rows) for (const part of row) if (typeof part === 'string')
        occurrences += part.split(fragment).length - 1;
      if (occurrences < 2) continue;
      const savings = (Buffer.byteLength(fragment) - 5) * occurrences - Buffer.byteLength(JSON.stringify(fragment)) - 8;
      if (savings > 12 && (!best || savings > best.savings || savings === best.savings && fragment < best.fragment))
        best = { fragment, savings };
    }
    if (!best) break;
    const index = dictionary.length; dictionary.push(best.fragment);
    rows = rows.map(row => row.flatMap(part => {
      if (typeof part !== 'string' || !part.includes(best.fragment)) return [part];
      const fragments = part.split(best.fragment), output = [];
      fragments.forEach((fragment, at) => { if (at) output.push(index); if (fragment.length) output.push(fragment); });
      return output;
    }));
  }
  if (!dictionary.length) return null;
  const table = { encoding: 'literal_parts_v1', dictionary, rows };
  if (JSON.stringify(decodeContinuationLiteralParts(table)) !== JSON.stringify(values))
    throw Error('story_continuation_literal_roundtrip_changed');
  return Buffer.byteLength(JSON.stringify(table)) < Buffer.byteLength(JSON.stringify(values)) ? table : null;
}

