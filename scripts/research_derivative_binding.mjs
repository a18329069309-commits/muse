// Verifies the explicitly supported public research derivative. No execution, downloads or qualification.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const equalPath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const check = (condition, code) => { if (!condition) throw new Error('research_derivative_' + code); };
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.00001;
async function hash(file, options) {
  const value = createHash('sha256'); for await (const chunk of createReadStream(file, options)) value.update(chunk); return value.digest('hex');
}

// This exact insert was verified in the prior public-source advertisement audit.
const MODU_AD_SHA256 = '88e7eca07ce6621b25f83ac41d9e079dae60dad3884f96a3607c843eb0390d93';
const MODU_AD_BYTES = 7382948;

function validateModuApi(row, candidate, work, episode, sourceWork, original, documents) {
  const proof = row.identity_evidence.public_source_check, page = new URL(row.source_page);
  check(!Object.keys(sourceWork).some(key => key.startsWith('official_')
    && !(key === 'official_attribution_verified' && sourceWork[key] === false)), 'official_claim_forbidden');
  check(page.protocol === 'https:' && ['www.mdzyapi.com', 'mdzyapi.com'].includes(page.hostname)
    && !page.username && !page.password && !page.port && !page.hash && page.pathname === '/api.php/provide/vod/'
    && page.searchParams.size === 2 && page.searchParams.get('ac') === 'detail' && page.searchParams.get('wd')?.trim()
    && episode.source_page === row.source_page && original.source_page === row.source_page
    && proof?.schema === 'third_party_public_api_binding_v1' && proof.passed === true
    && proof.official_attribution_verified === false && proof.source_origin === 'modum3u8'
    && proof.platform_series_id === row.platform_series_id && proof.page_episode_number === row.episode_number
    && proof.source_directory_count === row.source_episode_count
    && row.identity_evidence.source_page_episode_ordinal === row.episode_number
    && row.source_episode_id === `${row.platform_series_id}:modum3u8:${row.episode_number}`, 'api_ordinal_mismatch');
  check(['work_id', 'platform', 'platform_series_id', 'source_version_id', 'source_episode_count', 'split', 'series_group_id']
    .every(key => sourceWork[key] === row[key] && work[key] === row[key] && candidate[key] === row[key])
    && ['source_version', 'source_episode_id', 'episode_number', 'source_page', 'sha256'].every(key => candidate[key] === row[key])
    && row.source_version === `${row.source_version_id}:${row.sha256}` && equalPath(candidate.video, row.video)
    && sourceWork.official_attribution_verified === false && sourceWork.counts_toward_screenshot_coverage === false
    && sourceWork.clean_music_asset_eligible === false && candidate.research_input_eligible === true
    && candidate.counts_toward_screenshot_coverage === false && candidate.confirmed_catalogue_episode === false
    && same(proof, candidate.identity_evidence?.public_source_check), 'api_source_identity_changed');
  const api = documents.filter(item => equalPath(item.binding.path, proof.public_api_response_file));
  check(api.length === 1 && equalPath(sourceWork.source_catalogue_file, api[0].binding.path)
    && [sourceWork.source_catalogue_sha256, proof.public_api_response_sha256, proof.source_page_sha256]
      .every(value => value === api[0].binding.sha256) && api[0].value.code === 1, 'api_response_binding_required');
  const titles = api[0].value.list?.filter(item => String(item.vod_id) === row.platform_series_id);
  check(titles?.length === 1, 'api_vod_identity_mismatch');
  const origins = titles[0].vod_play_from?.split('$$$'), playlists = titles[0].vod_play_url?.split('$$$');
  check(origins?.filter(value => value === 'modum3u8').length === 1 && playlists?.length === origins.length, 'api_origin_mismatch');
  const chapters = playlists[origins.indexOf('modum3u8')].split('#');
  const chapter = chapters[row.episode_number - 1]?.split('$');
  check(chapters.length === row.source_episode_count && chapter?.length === 2
    && chapter[0] === proof.source_label && chapter[0] === original.source_label, 'api_chapter_mismatch');
  const url = new URL(chapter[1]);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && chapter[1] === original.public_playlist_url && chapter[1] === episode.public_playlist_url
    && digest(chapter[1]) === proof.playlist_url_sha256 && proof.playlist_url_sha256 === episode.playlist_url_sha256,
  'api_playlist_changed');
  check(documents.some(item => item.value?.[row.platform_series_id]?.[row.episode_number] === row.identity_evidence.actual_frame_observations)
    && candidate.identity_evidence.actual_frame_observations === row.identity_evidence.actual_frame_observations, 'frozen_frame_observation_required');
  return api[0].binding;
}

async function validateModuSegments(original, transform, parentBytes) {
  const attempt = /^original-attempt-(\d+)\.ts$/.exec(path.basename(transform.parent_path));
  check(attempt, 'source_hls_binding_required');
  const file = path.join(path.dirname(transform.parent_path), `source-attempt-${attempt[1]}.m3u8`);
  const bytes = await readFile(file), text = bytes.toString('utf8'), lines = text.split(/\r?\n/).map(line => line.trim());
  // The acquisition records UTF-8 response text with LF, then Windows write_text saves CRLF.
  const rawHash = digest(bytes), textHash = digest(text.replace(/\r\n/g, '\n'));
  check([rawHash, textHash].includes(original.source_hls_sha256)
    && lines[0] === '#EXTM3U' && lines.includes('#EXT-X-ENDLIST'), 'source_hls_changed');
  const parsed = []; let pending = null;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('#EXTINF:')) {
      check(pending === null, 'hls_segment_mapping_ambiguous');
      pending = { duration: Number(line.slice(8).split(',')[0]), tag: index };
    } else if (line && !line.startsWith('#')) {
      check(pending && Number.isFinite(pending.duration) && pending.duration > 0, 'hls_segment_mapping_ambiguous');
      parsed.push({ ...pending, uri: index, url: new URL(line, original.public_playlist_url).href }); pending = null;
    }
  }
  const segments = original.source_segments;
  check(pending === null && parsed.length > 0 && segments?.length === parsed.length, 'hls_segment_mapping_required');
  let byteCursor = 0, timeCursor = 0;
  for (const [index, segment] of segments.entries()) {
    const expected = parsed[index];
    check(segment.duration_tag_line === expected.tag && segment.uri_line === expected.uri
      && digest(expected.url) === segment.url_sha256 && close(segment.duration_seconds, expected.duration)
      && Number.isSafeInteger(segment.byte_start) && Number.isSafeInteger(segment.byte_end)
      && segment.byte_start === byteCursor && segment.byte_end > byteCursor && segment.byte_end <= parentBytes
      && close(segment.source_start_seconds, timeCursor) && close(segment.source_end_seconds, timeCursor + expected.duration),
    'hls_segment_mapping_changed');
    check(await hash(transform.parent_path, { start: segment.byte_start, end: segment.byte_end - 1 }) === segment.sha256, 'source_segment_hash_changed');
    byteCursor = segment.byte_end; timeCursor += expected.duration;
  }
  check(byteCursor === parentBytes && original.parent_bytes === parentBytes
    && close(timeCursor, original.source_hls_duration_seconds) && close(timeCursor, transform.source_hls_duration_seconds), 'source_hls_duration_changed');
  for (const [index, range] of transform.removed_ad_byte_ranges.entries()) {
    const first = segments.find(segment => segment.byte_start === range[0]), last = segments.find(segment => segment.byte_end === range[1]);
    check(first && last && close(first.source_start_seconds, transform.removed_source_hls_seconds[index][0])
      && close(last.source_end_seconds, transform.removed_source_hls_seconds[index][1])
      && close(last.source_end_seconds - first.source_start_seconds, 17.568), 'removed_ad_time_mismatch');
  }
  return { path: file, sha256: rawHash, recorded_text_sha256: original.source_hls_sha256,
    normalization: rawHash === original.source_hls_sha256 ? 'none' : 'crlf_to_lf_for_recorded_text_hash' };
}

export async function validatePublicResearchDerivative(row, candidate, acquisition, evidenceFiles) {
  const { document, work, episode } = acquisition, transform = row.transform, identity = row.identity_evidence;
  const modu = row.platform === 'modu_public';
  check(['public_research_derivative', 'third_party_public_research_derivative'].includes(document.source_kind) && document.official_attribution_verified === false
    && document.counts_toward_screenshot_coverage === false && episode.status === 'verified_local_research_derivative', 'provenance_required');
  for (const value of [row, candidate, work]) check(!Object.keys(value).some(key => key.startsWith('official_')
    && !(key === 'official_attribution_verified' && value[key] === false)), 'official_claim_forbidden');
  check((modu ? ['research', 'heldout'].includes(row.split) : row.platform === 'qscpt' && row.split === 'research') && row.clean_music_asset_eligible === false
    && candidate.clean_music_asset_eligible === false && row.confirmed_catalogue_episode === false
    && row.counts_toward_screenshot_coverage === false && row.research_input_eligible === true
    && Number.isInteger(row.source_episode_count) && row.source_episode_count === work.source_episode_count
    && row.episode_number >= 1 && row.episode_number <= row.source_episode_count
    && /unknown/.test(row.source_episode_mapping ?? '') && identity?.actual_frame_observations?.trim()
    && row.actual_frames_observed === true && candidate.actual_frames_observed === true, 'research_scope_required');
  check(transform?.kind === 'exact_matching_insert_byte_removal_and_copy_remux' && transform.raw_source_preserved === true
    && transform.source_version_id === row.source_version_id && transform.output_sha256 === row.sha256
    && same(transform, candidate.transform) && same(transform, episode.transform), 'transform_identity_changed');
  check(equalPath(row.transform_record_file, candidate.transform_record_file) && equalPath(row.transform_record_file, episode.transform_record_file)
    && /^[a-f0-9]{64}$/.test(row.transform_record_sha256 ?? '') && row.transform_record_sha256 === candidate.transform_record_sha256
    && row.transform_record_sha256 === episode.transform_record_sha256, 'transform_record_binding_required');
  const transformBytes = await readFile(row.transform_record_file);
  check(digest(transformBytes) === row.transform_record_sha256
    && same(JSON.parse(transformBytes.toString('utf8').replace(/^\uFEFF/, '')), transform), 'transform_record_changed');
  check(work.work_id === row.work_id && work.split === row.split && work.platform_series_id === row.platform_series_id
    && work.source_version_id === row.source_version_id && episode.source_episode_id === row.source_episode_id
    && episode.episode_number === row.episode_number && episode.media?.sha256 === row.sha256
    && equalPath(episode.media.path, row.video) && episode.media.full_decode_success === true && row.full_decode_success === true
    && close(episode.media.duration_seconds, row.duration_seconds) && episode.media.streams?.some(item => item.codec_type === 'video')
    && episode.media.streams?.some(item => item.codec_type === 'audio'), 'derived_media_binding_mismatch');
  const page = new URL(row.source_page), publicCheck = identity.public_source_check;
  if (!modu) check(page.protocol === 'https:' && page.hostname === 'qscpt.com' && page.pathname === `/qscpt/${row.platform_series_id}`
    && page.searchParams.get('origin') === 'modum3u8' && Number(page.searchParams.get('p')) + 1 === row.episode_number
    && row.source_episode_id === `${row.platform_series_id}:modum3u8:p=${row.episode_number - 1}`
    && episode.source_page === row.source_page && identity.source_page_episode_ordinal === row.episode_number
    && publicCheck?.passed === true && publicCheck.schema === 'third_party_public_page_binding_v1'
    && publicCheck.official_attribution_verified === false && publicCheck.page_episode_number === row.episode_number
    && publicCheck.source_directory_count === row.source_episode_count && publicCheck.source_origin === 'modum3u8'
    && /^[a-f0-9]{64}$/.test(publicCheck.source_page_sha256 ?? ''), 'page_ordinal_mismatch');
  check(Array.isArray(evidenceFiles) && evidenceFiles.length > 0, 'frozen_evidence_required');
  const documents = [];
  for (const binding of evidenceFiles) {
    const bytes = await readFile(binding.path); check(digest(bytes) === binding.sha256, 'evidence_hash_changed');
    documents.push({ binding, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) });
  }
  const frozen = documents.filter(item => equalPath(item.binding.path, transform.frozen_manifest));
  check(frozen.length === 1, 'transform_manifest_required');
  const originals = frozen[0].value.episodes?.filter(item => item.episode_number === row.episode_number && item.source_episode_id === row.source_episode_id);
  if (modu) check(originals?.length === 1, 'original_episode_identity_ambiguous');
  const original = originals?.[0];
  check(original?.status === 'verified_local_research_derivative' && same(original.media, episode.media)
    && equalPath(original.parent_path, transform.parent_path) && original.parent_sha256 === transform.parent_sha256
    && same(original.removed_ad_byte_ranges, transform.removed_ad_byte_ranges)
    && same(original.source_hls_ad_ranges_seconds, transform.removed_source_hls_seconds), 'original_transform_record_mismatch');
  const apiBinding = modu ? validateModuApi(row, candidate, work, episode, frozen[0].value, original, documents) : null;
  const frames = identity.frames;
  check(frames?.length === 3 && same(frames, candidate.identity_evidence?.frames) && same(frames, original.frames)
    && ['first', 'middle', 'last'].every((label, index) => frames[index].label === label
      && frames[index].time_seconds >= 0 && frames[index].time_seconds < row.duration_seconds
      && (!index || frames[index].time_seconds > frames[index - 1].time_seconds)), 'actual_frame_mapping_required');
  const parentBytes = (await stat(transform.parent_path)).size, removed = transform.removed_ad_byte_ranges;
  check(Array.isArray(removed) && removed.length > 0 && removed.every((range, index) => range.length === 2
    && range.every(Number.isSafeInteger) && range[0] >= 0 && range[1] > range[0] && range[1] <= parentBytes
    && (!index || range[0] >= removed[index - 1][1])), 'byte_ranges_invalid');
  const ranges = transform.removed_source_hls_seconds, total = transform.source_hls_duration_seconds;
  check(ranges?.length === removed.length && Number.isFinite(total) && total > 0
    && ranges.every((range, index) => range.length === 2 && range.every(Number.isFinite) && range[0] >= 0
      && range[1] > range[0] && range[1] <= total && (!index || range[0] >= ranges[index - 1][1])), 'hls_ranges_invalid');
  const retained = []; let sourceCursor = 0, outputCursor = 0;
  for (const [start, end] of [...ranges, [total, total]]) {
    if (start > sourceCursor) {
      retained.push({ source_hls_seconds: [sourceCursor, start], derivative_nominal_seconds: [outputCursor, outputCursor + start - sourceCursor] });
      outputCursor += start - sourceCursor;
    }
    sourceCursor = end;
  }
  check(retained.length === transform.retained_time_ranges?.length && retained.every((range, index) =>
    ['source_hls_seconds', 'derivative_nominal_seconds'].every(key => range[key].every((value, end) => close(value, transform.retained_time_ranges[index][key]?.[end]))))
    && close(transform.derivative_duration_seconds, row.duration_seconds)
    && close(transform.mux_duration_delta_seconds, row.duration_seconds - outputCursor)
    && transform.source_to_derivative_time_basis?.includes('unverified'), 'timeline_mapping_changed');
  check(await hash(transform.parent_path) === transform.parent_sha256, 'parent_hash_changed');
  check(await hash(row.video) === row.sha256, 'media_hash_changed');
  for (const frame of frames) check(await hash(frame.path) === frame.sha256, 'frame_hash_changed');
  const adHash = frozen[0].value.known_ad_block_sha256;
  check(/^[a-f0-9]{64}$/.test(adHash ?? ''), 'ad_block_hash_required');
  if (modu) check(adHash === MODU_AD_SHA256 && original.known_ad_block_sha256 === adHash
    && transform.known_ad_block_sha256 === adHash && transform.removed_ad_block_sha256 === adHash
    && removed.every(([start, end]) => end - start === MODU_AD_BYTES), 'known_modu_ad_required');
  for (const [start, end] of removed) check(await hash(transform.parent_path, { start, end: end - 1 }) === adHash, 'removed_bytes_not_verified_ad');
  const hlsBinding = modu ? await validateModuSegments(original, transform, parentBytes) : null;
  return { mode: 'public_research_derivative', evidence_files: evidenceFiles, transform_manifest: frozen[0].binding,
    transform_record: { path: row.transform_record_file, sha256: row.transform_record_sha256 },
    parent: { path: transform.parent_path, sha256: transform.parent_sha256 }, removed_ad_sha256: adHash,
    official_attribution_verified: false, clean_music_asset_eligible: false, screenshot_coverage_added: 0,
    ...(modu ? { platform: 'modu_public', split: row.split, heldout_isolated: row.split === 'heldout',
      public_api_response: apiBinding, source_hls: hlsBinding } : {}) };
}
