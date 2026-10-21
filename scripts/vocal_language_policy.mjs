import { readFileSync } from 'node:fs';

// Host-only frozen registry. Never add this table to a model request/schema.
const registry = JSON.parse(readFileSync(new URL('../references/iana-primary-language-subtags.json', import.meta.url), 'utf8'));
export const vocalLanguageRegistryRevision = registry.revision;
const registered = new Set(registry.codes);
const nonConcrete = new Set(['und', 'mul', 'zxx', 'mis']);
export const isConcreteVocalLanguage = value => typeof value === 'string'
  && registered.has(value) && !nonConcrete.has(value);
// This describes a REQUEST preference, not an observed recording language.
// IANA und=Undetermined: retain the original value while interpreting its
// preference as unrestricted. Never promote und/unknown to a sound fact.
export const isUnrestrictedVocalPreference = value => value === 'unknown' || value === 'und';
export const isVocalLanguagePreference = value => isUnrestrictedVocalPreference(value) || isConcreteVocalLanguage(value);
export const vocalLanguageMatches = (requested, actual) => isConcreteVocalLanguage(actual)
  && (isUnrestrictedVocalPreference(requested) || isConcreteVocalLanguage(requested) && requested === actual);

export const routeLanguageSummaryPolicyRevision = 'route-language-summary-preflight-v1';
export const routeLanguageSummaryInstruction = ' When the user has not explicitly restricted lyric language, set vocal_language=unknown; compare suitable languages, never infer a hard language restriction from plot/dialogue language or encoding. '
  + 'An explicit lyric-language request must remain unchanged. Concrete values must be registered lowercase IANA primary language subtags (for example zh, en, ja, ko, yue); utf/exl are invalid. und means undetermined, not a verified material language. '
  + 'global_route_summary must be prose describing the COMPLETE ordered episode sound development, character control/danger/relationship changes and continuity; never return only beat/cue/evidence IDs. No language label or summary grants sound or production approval.';

// Explicit new-policy preflight. Historical receipt/merge verification keeps
// its original semantics; callers can report these gaps without rewriting it.
export function directionRoutePolicyGaps(direction, analysis) {
  const gaps = [], summary = direction.global_route_summary;
  const ids = [...new Set([
    ...(analysis.story_beats ?? []).flatMap(beat => [beat.id, ...(beat.evidence_ids ?? [])]),
    ...(analysis.sound_events ?? []).map(event => event.id ?? event.event_id),
    ...(direction.cues ?? []).map(cue => cue.cue_id),
  ].filter(value => typeof value === 'string' && value))].sort((a, b) => b.length - a.length);
  if (typeof summary !== 'string' || !summary.trim()) gaps.push('global_sound_route_required');
  else {
    const remainder = ids.reduce((text, id) => text.split(id).join(''), summary)
      .replace(/[\s\p{P}\p{S}]/gu, '');
    if (!remainder) gaps.push('global_sound_route_prose_required');
  }
  for (const cue of direction.cues ?? [])
    if (Object.hasOwn(cue, 'vocal_language') && !isVocalLanguagePreference(cue.vocal_language))
      gaps.push('vocal_language_preference_invalid:' + cue.cue_id);
  return gaps;
}
