import { projectTrialPreflight } from './project_trial_gate.mjs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashFile } from './render_binding.mjs';
import { createFinalMixMaster, validateFinalMixMasterConfig } from './final_mix_master.mjs';
import { decodeWithBoundedRenderCache, validateRenderDecodeCacheConfig } from './render_decode_cache.mjs';
import {executeSfxAudibilityRepair,validateSfxAudibilityRepairPolicy} from './sfx_audibility_repair.mjs';

const RATE = 48000;
const TRACKS = ['bgm', 'sfx', 'ambience'];
const fail = message => { throw new Error(message); };
const finite = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} must be finite`);
  return value;
};
const samples = value => Math.round(value * RATE);
const pcmSample = value => Math.max(-8388608, Math.min(8388607, Math.round(value * 8388608)));
const resolveFile = (base, value, label) => {
  if (typeof value !== 'string' || !value) fail(`${label} must be a file path`);
  return path.resolve(base, value);
};
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { windowsHide: true, shell: false });
  const chunks = [];
  let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk));
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.on('error', () => reject(new Error(`${command} could not start`)));
  child.on('close', code => code === 0
    ? resolve({ stdout: Buffer.concat(chunks), stderr })
    : reject(new Error(`${command} failed (exit ${code}); check the input audio`)));
});

async function decode(file, cache) {
  if (!(await stat(file)).isFile()) fail('Audio asset is not a file');
  const legacyDecode = async () => (await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0',
    '-ar', String(RATE), '-ac', '2', '-f', 'f32le', 'pipe:1'])).stdout;
  let stdout;
  if(cache){const decoded=await decodeWithBoundedRenderCache(file,{policy:cache.policy,python:cache.python,legacyDecode});
    stdout=decoded.bytes;cache.records.push(decoded.receipt);}
  else stdout=await legacyDecode();
  if (!stdout.length || stdout.length % 8) fail('Decoded audio has invalid sample length');
  const data = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length));
  for (const value of data) if (!Number.isFinite(value)) fail('Audio contains non-finite samples');
  return data;
}

function peak(data) {
  let maximum = 0;
  for (const value of data) {
    if (!Number.isFinite(value)) fail('Mix contains non-finite samples');
    maximum = Math.max(maximum, Math.abs(value));
  }
  return { linear: maximum, dbfs: maximum ? 20 * Math.log10(maximum) : null,
    silence: maximum === 0, clipped: maximum >= 1 };
}

async function writeWav(file, data) {
  const buffer = Buffer.alloc(44 + data.length * 3);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVEfmt ', 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(RATE, 24); buffer.writeUInt32LE(RATE * 6, 28);
  buffer.writeUInt16LE(6, 32); buffer.writeUInt16LE(24, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(data.length * 3, 40);
  for (let i = 0; i < data.length; i++) {
    buffer.writeIntLE(pcmSample(data[i]), 44 + i * 3, 3);
  }
  await writeFile(file, buffer);
}

async function loudness(file) {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-f', 'f32le',
    '-ar', String(RATE), '-ac', '2', '-i', file, '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const integrated = summary.match(/I:\s*([-+\d.]+|[-+]?inf)\s+LUFS/i);
  const truePeak = summary.match(/Peak:\s*([-+\d.]+|[-+]?inf)\s+dBFS/i);
  if (!integrated || !truePeak) fail('FFmpeg did not report complete-mix loudness / true peak');
  const numeric = text => Number.isFinite(Number(text)) ? Number(text) : null;
  return { integrated_lufs: numeric(integrated[1]), true_peak_dbfs: numeric(truePeak[1]),
    true_peak_text: truePeak[1], method: 'FFmpeg ebur128=peak=true on original + delivered 24-bit accompaniment' };
}

function validateIntervals(intervals, duration) {
  if (intervals === undefined) return null;
  if (!Array.isArray(intervals)) fail('dialogue_intervals must be an array');
  return intervals.map(interval => {
    const start = finite(interval.start_seconds, 'dialogue start');
    const end = finite(interval.end_seconds, 'dialogue end');
    if (start < 0 || end <= start || end > duration) fail('Dialogue interval is outside the timeline');
    return { start: samples(start), end: samples(end) };
  });
}

function duckMusic(data, intervals, length, reductionDb) {
  const envelope = new Float32Array(length).fill(1);
  const minimum = 10 ** (-reductionDb / 20), lead = samples(0.05), release = samples(0.2);
  for (const { start, end } of intervals) {
    for (let i = Math.max(0, start - lead); i < Math.min(length, end + release); i++) {
      const factor = i < start ? 1 - (1 - minimum) * (i - (start - lead)) / lead
        : i < end ? minimum : minimum + (1 - minimum) * (i - end) / release;
      envelope[i] = Math.min(envelope[i], factor);
    }
  }
  for (let i = 0; i < length; i++) {
    data[i * 2] *= envelope[i]; data[i * 2 + 1] *= envelope[i];
  }
}

export async function renderPlan(planFile, outputDirectory, { policyPath, cwd, finalMixMaster, renderDecodeCache, python,
  sfxAudibilityRepair,soundDecisionsFile } = {}) {
  const projectGate = await projectTrialPreflight({ output_dir: outputDirectory },
    { operation: 'render_plan', inputFiles: [path.resolve(planFile)], policyPath, cwd });
  if (projectGate) return projectGate;
  if (finalMixMaster !== undefined) validateFinalMixMasterConfig(finalMixMaster);
  if(sfxAudibilityRepair!==undefined)validateSfxAudibilityRepairPolicy(sfxAudibilityRepair);
  const decodeCache=renderDecodeCache===undefined?null:{policy:validateRenderDecodeCacheConfig(renderDecodeCache),python,records:[]};
  if(decodeCache&&!path.isAbsolute(python??''))fail('render_decode_cache_explicit_python_required');

  const output = path.resolve(outputDirectory);
  try {
    if ((await readdir(output)).length) fail('Output directory must be empty; existing results will not be overwritten');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const planPath = path.resolve(planFile), base = path.dirname(planPath);
  let effectivePlanPath=planPath,sfxRepair;
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  if (plan.schema_version !== 1) fail('Unsupported plan schema');
  for (const [key, choices] of Object.entries({ audience: ['auto', 'male', 'female'], mode: ['generate', 'materials'],
    execution: ['api', 'host', 'local'], original_audio_kind: ['dialogue_only', 'mixed', 'none', 'unknown'] })) {
    if (!choices.includes(plan[key])) fail(`Invalid ${key}`);
  }
  const duckingDb = finite(plan.dialogue_ducking_db === undefined ? 10 : plan.dialogue_ducking_db, 'dialogue_ducking_db');
  if (duckingDb < 0 || duckingDb > 18) fail('dialogue_ducking_db must be between 0 and 18');
  const manifestPath = resolveFile(base, plan.manifest, 'manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schema_version !== 1 || manifest.timeline?.sample_rate !== RATE) fail('Unsupported manifest / sample rate');
  if (manifest.analysis_window !== undefined || !manifest.original_audio) fail('An analysis window cannot render a full episode');
  const length = manifest.timeline.duration_samples;
  if (!Number.isSafeInteger(length) || length <= 0) fail('Invalid timeline duration_samples');
  const duration = length / RATE;
  const source = resolveFile(path.dirname(manifestPath), manifest.source_video, 'source_video');
  if (!/^[a-f0-9]{64}$/i.test(manifest.source_sha256 ?? '') ||
    await hashFile(source) !== manifest.source_sha256.toLowerCase()) fail('Source video SHA-256 mismatch');
  const original = await decode(resolveFile(path.dirname(manifestPath), manifest.original_audio, 'original_audio'),decodeCache);
  if (original.length !== length * 2) fail('Original audio sample length does not match manifest');
  const inputBinding = { schema_version: 1, plan_sha256: await hashFile(planPath),
    manifest_sha256: await hashFile(manifestPath),
    original_audio_sha256: await hashFile(resolveFile(path.dirname(manifestPath), manifest.original_audio, 'original_audio')),
    asset_sha256: {} };
  const intervals = validateIntervals(plan.dialogue_intervals, duration);
  const hasKnownIntervals = intervals !== null && intervals.length > 0;
  const needsDialogueIntervals = manifest.has_source_audio && plan.original_audio_kind !== 'none';
  if (!Array.isArray(plan.assets) || !Array.isArray(plan.cues)) fail('assets and cues must be arrays');
  const assets = new Map();
  for (const asset of plan.assets) {
    if (typeof asset.id !== 'string' || !asset.id || assets.has(asset.id)) fail('Missing / duplicate asset id');
    assets.set(asset.id, await decode(resolveFile(base, asset.path, 'asset path'),decodeCache));
    inputBinding.asset_sha256[asset.id] = await hashFile(resolveFile(base, asset.path, 'asset path'));
  }
  const ids = new Set(), placements = [];
  for (const cue of plan.cues) {
    if (typeof cue.id !== 'string' || !cue.id || ids.has(cue.id)) fail('Missing / duplicate cue id');
    ids.add(cue.id);
    if (!TRACKS.includes(cue.track)) fail('Invalid cue track');
    const data = assets.get(cue.asset_id);
    if (!data) fail('Cue refers to an unknown asset');
    const sourceIn = finite(cue.source_in_seconds, 'source_in_seconds');
    const sourceOut = finite(cue.source_out_seconds, 'source_out_seconds');
    const input = samples(sourceIn), end = samples(sourceOut), segment = end - input;
    if (sourceIn < 0 || sourceOut <= sourceIn || sourceOut > data.length / 2 / RATE || segment <= 0) {
      fail('Cue source range exceeds the real decoded asset');
    }
    const hasStart = Object.hasOwn(cue, 'start_seconds'), hasSync = Object.hasOwn(cue, 'sync');
    if (hasStart === hasSync) fail('Use exactly one of start_seconds or sync');
    let start, target = null, anchor = null;
    if (hasSync) {
      const targetSeconds = finite(cue.sync?.target_seconds, 'sync target');
      const anchorSeconds = finite(cue.sync?.source_anchor_seconds, 'sync source anchor');
      target = samples(targetSeconds); anchor = samples(anchorSeconds);
      if (targetSeconds < 0 || target >= length) fail('Sync target is outside the timeline');
      if (anchorSeconds < sourceIn || anchorSeconds >= sourceOut || anchor < input || anchor >= end) {
        fail('Source anchor is outside the selected source range');
      }
      start = target - (anchor - input);
    } else start = samples(finite(cue.start_seconds, 'start_seconds'));
    if (start >= length || start + segment <= 0) fail('Cue does not overlap the timeline');
    if (start + segment > length) fail('Cue tail exceeds timeline; explicitly shorten source_out_seconds / design a fade');
    const gainDb = finite(cue.gain_db === undefined ? 0 : cue.gain_db, 'gain_db'), gain = 10 ** (gainDb / 20);
    if (!Number.isFinite(gain)) fail('gain_db produces a non-finite gain');
    const fadeInSeconds = finite(cue.fade_in_seconds === undefined ? 0 : cue.fade_in_seconds, 'fade_in_seconds');
    const fadeOutSeconds = finite(cue.fade_out_seconds === undefined ? 0 : cue.fade_out_seconds, 'fade_out_seconds');
    if (fadeInSeconds < 0 || fadeOutSeconds < 0 || fadeInSeconds > sourceOut - sourceIn ||
      fadeOutSeconds > sourceOut - sourceIn) fail('Fade is outside the selected segment duration');
    const fadeCurve = cue.fade_curve ?? 'linear';
    if (!['linear', 'raised_cosine', 'equal_power'].includes(fadeCurve)) fail('Unsupported fade_curve');
    let gainEnvelope = null;
    if (cue.gain_envelope !== undefined) {
      if (!Array.isArray(cue.gain_envelope) || cue.gain_envelope.length < 2) fail('gain_envelope requires at least two points');
      gainEnvelope = cue.gain_envelope.map(point => {
        const offset = samples(finite(point.offset_seconds, 'gain envelope offset'));
        const gainDb = finite(point.gain_db, 'gain envelope dB');
        if (offset < 0 || offset > segment || !Number.isFinite(10 ** (gainDb / 20))) fail('Invalid gain envelope point');
        return { offset_sample: offset, gain_db: gainDb };
      });
      if (gainEnvelope[0].offset_sample !== 0 || gainEnvelope.at(-1).offset_sample !== segment ||
        gainEnvelope.some((point, i) => i > 0 && point.offset_sample <= gainEnvelope[i - 1].offset_sample)) {
        fail('gain_envelope must span the source segment with increasing sample offsets');
      }
    }
    placements.push({ id: cue.id, track: cue.track, asset_id: cue.asset_id, source_in_sample: input,
      source_out_sample: end, start_sample: start, target_sample: target, source_anchor_sample: anchor,
      leading_trim_samples: Math.max(0, -start), rendered_start_sample: Math.max(0, start),
      end_sample: start + segment, gain_db: gainDb, gain,
      fade_in_samples: samples(fadeInSeconds), fade_out_samples: samples(fadeOutSeconds),
      fade_curve: fadeCurve, gain_envelope: gainEnvelope });
  }
  const stems = Object.fromEntries(TRACKS.map(track => [track, new Float32Array(length * 2)]));
  for (const cue of placements) {
    const input = assets.get(cue.asset_id), output = stems[cue.track];
    const segment = cue.source_out_sample - cue.source_in_sample;
    let contributionPeak = 0, envelopeIndex = 0;
    for (let i = cue.leading_trim_samples; i < segment; i++) {
      const fadePosition = Math.min(1, cue.fade_in_samples ? i / cue.fade_in_samples : 1,
        cue.fade_out_samples ? (segment - 1 - i) / cue.fade_out_samples : 1);
      const fade = cue.fade_curve === 'raised_cosine' ? (1 - Math.cos(Math.PI * fadePosition)) / 2
        : cue.fade_curve === 'equal_power' ? Math.sin(Math.PI * fadePosition / 2) : fadePosition;
      let automatedGain = 1;
      if (cue.gain_envelope) {
        while (envelopeIndex < cue.gain_envelope.length - 2 && i >= cue.gain_envelope[envelopeIndex + 1].offset_sample) envelopeIndex++;
        const a = cue.gain_envelope[envelopeIndex], b = cue.gain_envelope[envelopeIndex + 1];
        const gainDb = a.gain_db + (b.gain_db - a.gain_db) * (i - a.offset_sample) / (b.offset_sample - a.offset_sample);
        automatedGain = 10 ** (gainDb / 20);
      }
      for (let channel = 0; channel < 2; channel++) {
        const value = input[(cue.source_in_sample + i) * 2 + channel] * cue.gain * automatedGain * fade;
        contributionPeak = Math.max(contributionPeak, Math.abs(value));
        output[(cue.start_sample + i) * 2 + channel] += value;
      }
    }
    cue.contribution_peak_pcm24 = Math.abs(pcmSample(contributionPeak)) / 8388608;
    cue.contribution_measurement = 'after_gain_automation_fades_and_leading_trim_before_stem_sum_and_bgm_ducking';
  }
  if (intervals) duckMusic(stems.bgm, intervals, length, duckingDb);
  if(sfxAudibilityRepair!==undefined){
    sfxRepair=await executeSfxAudibilityRepair({policy:sfxAudibilityRepair,planFile:planPath,plan,manifest,
      placements,assets,original,stems,inputBinding,soundDecisionsFile,finalMixMaster,
      outputDirectory:path.join(output,'sfx-audibility-repair')});
    if(sfxRepair.appliedPlan){
      effectivePlanPath=sfxRepair.appliedPlan.path;inputBinding.plan_sha256=sfxRepair.appliedPlan.sha256;
      stems.sfx=sfxRepair.stems.sfx;
      for(const change of sfxRepair.result.changes){
        const placement=placements.find(row=>row.id===change.cue_id);
        placement.gain_db=change.gain_after_db;placement.gain=10**(placement.gain_db/20);
        const task=sfxRepair.result.tasks.find(row=>row.cue_id===change.cue_id);
        const chosen=task.candidates.find(row=>row.delta_gain_db===change.delta_gain_db);
        placement.contribution_peak_pcm24=Math.abs(pcmSample(chosen.measurement.actual_contribution.peak_linear))/8388608;
      }
    }
  }
  const accompaniment = new Float32Array(length * 2), complete = new Float32Array(length * 2);
  for (let i = 0; i < accompaniment.length; i++) {
    accompaniment[i] = stems.bgm[i] + stems.sfx[i] + stems.ambience[i];
    complete[i] = original[i] + accompaniment[i];
  }
  const outputPeaks = Object.fromEntries([...Object.entries(stems), ['accompaniment', accompaniment]]
    .map(([name, data]) => [name, peak(data)]));
  const completePeak = peak(complete);
  for (let i = 0; i < complete.length; i++) complete[i] = original[i] + pcmSample(accompaniment[i]) / 8388608;
  const deliveredCompletePeak = peak(complete);
  await mkdir(output, { recursive: true });
  const temporary = path.join(output, '.complete-mix.f32le');
  let measured;
  try {
    await writeFile(temporary, Buffer.from(complete.buffer));
    measured = await loudness(temporary);
  } finally { await rm(temporary, { force: true }); }
  const issues = [];
  for (const [track, stats] of Object.entries(outputPeaks)) if (stats.clipped) issues.push(`${track}_digital_overload`);
  if (completePeak.clipped || deliveredCompletePeak.clipped) issues.push('original_plus_accompaniment_digital_overload');
  if (measured.true_peak_dbfs !== null && measured.true_peak_dbfs >= 0) issues.push('complete_mix_true_peak_at_or_above_0_dbfs');
  if (!hasKnownIntervals && needsDialogueIntervals) issues.push('dialogue_intervals_not_provided');
  if (['mixed', 'unknown'].includes(plan.original_audio_kind)) issues.push('original_audio_kind_requires_review');
  if (plan.original_audio_kind === 'none' && manifest.has_source_audio && peak(original).linear > 0) {
    issues.push('declared_no_audio_but_original_has_signal');
  }
  const outputHashes = {};
  for (const [name, data] of [...Object.entries(stems), ['accompaniment', accompaniment]]) {
    await writeWav(path.join(output, `${name}.wav`), data);
    outputHashes[name] = await hashFile(path.join(output, `${name}.wav`));
  }
  const report = {
    schema_version: 1, status: issues.length ? 'needs_mix_review' : 'technical_ok',
    creative_review: 'not_performed', audible_sync_review: 'not_performed', source_sha256: manifest.source_sha256,
    sample_rate: RATE, channels: 2, bit_depth: 24, duration_samples: length, duration_seconds: duration,
    input_binding: inputBinding, output_sha256: outputHashes,
    output_sample_peaks_before_pcm_clamping: outputPeaks,
    complete_mix: { composition: 'original once + accompaniment once',
      sample_peak_before_pcm_clamping: completePeak,
      sample_peak_with_delivered_24bit_accompaniment: deliveredCompletePeak, ...measured },
    dialogue_ducking: { status: hasKnownIntervals ? 'applied_to_known_intervals'
      : needsDialogueIntervals ? 'not_provided' : 'not_required_by_source_metadata',
      known_intervals: intervals?.length ?? null, reduction_db: duckingDb, advance_seconds: 0.05,
      release_seconds: 0.2, overlapping_intervals: 'minimum_envelope_once' },
    cues: placements.map(({ gain, ...placement }) => placement), issues,
    import_instruction: 'Import the three stems OR accompaniment; retain original dialogue once. Audition required.',
    overload_note: 'PCM output is clamped if overloaded; needs_mix_review output is not approved for delivery.'
  };
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  // The raw report, four delivered WAVs and source clocks retain identical
  // meaning; the optional cache has no permanent media path consumer.
  if(decodeCache)await writeFile(path.join(output,'render-decode-cache.json'),JSON.stringify({
    schema_version:1,kind:'ephemeral_renderer_decode_cache_usage',policy:decodeCache.policy,
    records:decodeCache.records,source_evidence_deleted:false,qualification_granted:false,
    scope:'new_renderer_decode_cache_only_not_total_D_output_or_evidence_storage',
  },null,2)+'\n',{flag:'wx'});
  if (finalMixMaster !== undefined) {
    const derived = await createFinalMixMaster({ planFile: effectivePlanPath, renderDirectory: output, report, config: finalMixMaster });
    // The on-disk raw report and its four hashes keep their original meaning.
    // Only the returned job result adds separately bound derived artifacts.
    return { ...report, final_mix_master: { revision: finalMixMaster.revision,
      report: derived.report, final_mix: derived.final_mix, production_approval: false },
      ...(sfxRepair?{sfx_audibility_repair:{revision:sfxAudibilityRepair.revision,record:sfxRepair.record,
        status:sfxRepair.result.status,...(sfxRepair.appliedPlan?{applied_plan:sfxRepair.appliedPlan}:{}),
        fully_repaired:false,qualification_granted:false,production_approval:false}}:{}) };
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [plan, flag, output, ...extra] = process.argv.slice(2);
  if (!plan || flag !== '--out' || !output || extra.length) {
    console.error('Usage: node render_audio.mjs PLAN --out NEW_OUTPUT_DIRECTORY'); process.exitCode = 1;
  } else {
    renderPlan(plan, output).then(report => console.log(`${report.status}; ${report.duration_samples} samples; creative review not performed`))
      .catch(error => {
        console.error(error instanceof SyntaxError ? 'Invalid JSON in plan or manifest'
          : error.code ? `File operation failed (${error.code})` : error.message);
        process.exitCode = 1;
      });
  }
}
