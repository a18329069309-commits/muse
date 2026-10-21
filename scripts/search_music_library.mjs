import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';

// Curated tags rank candidates. They do not establish auditory or story acceptance.
const { values: args } = parseArgs({ options: Object.fromEntries([
  'index', 'function', 'substyle', 'energy', 'rhythmic-density', 'dialogue-space',
  'timbre', 'genre', 'avoid-track-ids', 'avoid-families', 'allow-track-ids',
  'reject-paths', 'limit', 'history', 'project-id',
].map(name => [name, { type: 'string' }])) });
const split = value => (value ?? '').split(',').map(s => s.trim()).filter(Boolean);
const includes = (values, value) => (values ?? []).includes(value);
const normalizePath = value => path.resolve(value).toLowerCase();

if (!args.index || !args.function) {
  throw new Error('Required: --index music-index.json --function narrative_function');
}
const index = JSON.parse(fs.readFileSync(args.index, 'utf8').replace(/^\uFEFF/, ''));
if (!Array.isArray(index.tracks)) throw new Error('Expected curated index with a tracks array.');
if (Boolean(args.history) !== Boolean(args['project-id'])) {
  throw new Error('--history and --project-id must be supplied together.');
}
const history = args.history
  ? JSON.parse(fs.readFileSync(args.history, 'utf8').replace(/^\uFEFF/, '')) : { uses: [] };
if (!Array.isArray(history.uses)) throw new Error('Expected history with a uses array.');
const matchesUse = (track, use) => Boolean(
  use.track_id && (track.track_id === use.track_id || (track.aliases ?? []).includes(use.track_id)) ||
  use.source_family && track.source_family === use.source_family ||
  use.source_sha256 && track.source_sha256 && track.source_sha256 === use.source_sha256
);
const limit = Number(args.limit ?? 5);
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer.');
const targets = [
  ['energy', args.energy], ['rhythmic_density', args['rhythmic-density']],
  ['dialogue_space', args['dialogue-space']],
].filter(([, value]) => value !== undefined).map(([key, value]) => [key, Number(value)]);
if (targets.some(([, value]) => !Number.isInteger(value) || value < 1 || value > 5)) {
  throw new Error('Energy, rhythmic density and dialogue space must be integers from 1 to 5.');
}
const avoidIds = new Set(split(args['avoid-track-ids']));
const avoidFamilies = new Set(split(args['avoid-families']));
const allowedIds = new Set(split(args['allow-track-ids']));
const rejectedPaths = new Set(split(args['reject-paths']).map(normalizePath));
const exclusions = [];
const candidates = [];

for (const indexedTrack of index.tracks) {
  const cached = Boolean(indexedTrack.local_path && fs.existsSync(indexedTrack.local_path) && fs.statSync(indexedTrack.local_path).isFile() && fs.statSync(indexedTrack.local_path).size > 0);
  const actualHash = cached ? createHash('sha256').update(fs.readFileSync(indexedTrack.local_path)).digest('hex') : undefined;
  const track = { ...indexedTrack, source_sha256: actualHash ?? indexedTrack.source_sha256 };
  let rejection;
  const otherProjectUses = history.uses.filter(use => use.project_id !== args['project-id'] && matchesUse(track, use));
  const usedInCurrentProject = history.uses.some(use => use.project_id === args['project-id'] && matchesUse(track, use));
  const reuseReasons = [];
  if (avoidIds.has(track.track_id) || (track.aliases ?? []).some(id => avoidIds.has(id))) reuseReasons.push('avoid_track');
  if (avoidFamilies.has(track.source_family)) reuseReasons.push('avoid_family');
  if (otherProjectUses.length) reuseReasons.push('other_project_in_current_batch');
  if (actualHash && indexedTrack.source_sha256 && actualHash !== indexedTrack.source_sha256) {
    rejection = 'cached_file_hash_mismatch';
  } else if (track.content_rejected || (track.local_path && rejectedPaths.has(normalizePath(track.local_path)))) {
    rejection = 'content_or_file_rejected';
  } else if (!allowedIds.has(track.track_id) && reuseReasons.length) {
    rejection = 'used_by_another_project';
  }
  if (rejection) {
    exclusions.push({ track_id: track.track_id, reason: rejection });
    continue;
  }
  if (!includes(track.narrative_functions, args.function)) continue;
  // An explicit substyle is a filter, preventing an unrelated fallback from silently winning.
  if (args.substyle && !includes(track.substyles, args.substyle)) continue;
  let score = 12;
  const reasons = [`function:${args.function}`];
  if (args.substyle) { score += 8; reasons.push(`substyle:${args.substyle}`); }
  for (const [field, target] of targets) {
    if (Number.isInteger(track[field])) {
      score += 4 - Math.abs(track[field] - target);
      reasons.push(`${field}:${track[field]} target:${target} hypothesis`);
    }
  }
  if (args.timbre && includes(track.timbre, args.timbre)) { score += 3; reasons.push(`timbre:${args.timbre}`); }
  if (args.genre && includes(track.genre_preferences, args.genre)) { score += 1; reasons.push(`genre:${args.genre}`); }
  candidates.push({ ...track, score, ranking_reasons: reasons,
    cache_status: cached ? 'cached_not_auditory_approved' : 'metadata_only',
    listening_status: track.listening_status ?? 'pending',
    used_in_current_project: usedInCurrentProject,
    explicit_reuse_exception: allowedIds.has(track.track_id) && reuseReasons.length > 0,
    reuse_exception_reasons: allowedIds.has(track.track_id) ? reuseReasons : [],
  });
}
candidates.sort((a, b) => b.score - a.score || a.track_id.localeCompare(b.track_id));
const seenFamilies = new Set();
const shortlist = candidates.filter(track => {
  const family = track.source_family ?? track.track_id;
  if (seenFamilies.has(family)) return false;
  seenFamilies.add(family);
  return true;
});
console.log(JSON.stringify({
  task: 'offline_candidate_retrieval_not_auditory_acceptance',
  query: args, indexed_tracks: index.tracks.length, matching_tracks: candidates.length,
  matching_families: shortlist.length, exclusions, candidates: shortlist.slice(0, limit),
  downloaded_now: 0, model_calls: 0, cloud_uploads: 0,
}, null, 2));
