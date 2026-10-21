import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { isOriginalRecordingRelation } from './music_profile.mjs';
import { verifyMusicSourceProvenance, evaluateMusicSourceBudget, musicSourceBudgetPolicy } from './music_source_budget.mjs';
import { writeFile } from 'node:fs/promises';
import { hasIndependentMusicPackFields, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';

const execute = promisify(execFile);

// Only an empty supply is conclusive before plot analysis. This never grants source or sound approval.
// Caller provenance and custom matchers can supply legitimate sources outside this snapshot.
export async function inspectEpisodeReferenceMusicSupply({ config, runtime = {}, out }) {
  if (hasIndependentMusicPackFields(config)) {
    await validateIndependentMusicPackPolicy(config, { outputDirectory: out });
    return { checked: false, blocked: false, reason: 'independent_pack_trial_does_not_require_reference_case_supply',
      reference_route_policy_unchanged: true, production_approval: false };
  }
  if (config.mode !== 'assisted_trial' || (config.strategy ?? 'case_presets') !== 'case_presets'
    || !config.cases?.db || config.music_source_provenance || runtime.caseMatcher)
    return { checked: false, blocked: false, reason: 'source_supply_not_closed_by_frozen_case_database' };
  const database = { path: path.resolve(config.cases.db), sha256: await hashFile(config.cases.db) };
  const script = 'import sys,json,sqlite3,pathlib\n'
    + 'db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True)\n'
    + 'tables={r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type=\'table\'")}\n'
    + 'if "windows" not in tables:\n'
    + ' print(json.dumps({"checked":False,"reason":"legacy_case_window_schema_unavailable"}))\n'
    + 'else:\n'
    + ' rows=db.execute("SELECT record_json FROM windows")\n'
    + ' total=0; originals=0; relations={}\n'
    + ' for row in rows:\n'
    + '  window=json.loads(row[0]); total+=1; relation=window.get("source_relation","unknown")\n'
    + '  relations[relation]=relations.get(relation,0)+1\n'
    + '  originals+=int(relation in ("reviewed_reference_match","reviewed_same_recording_window") and bool(window.get("original_recording_evidence")))\n'
    + ' print(json.dumps({"checked":True,"music_window_count":total,"source_relation_counts":relations,"reference_identity_window_count":originals}))\n';
  const response = await execute(config.python || 'python', ['-X', 'utf8', '-c', script, database.path],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  await verifyEvidenceBindings(database);
  const counts = JSON.parse(response.stdout);
  const result = { schema_version: 1, ...counts, database,
    blocked: counts.checked === true && counts.reference_identity_window_count === 0,
    policy: musicSourceBudgetPolicy, target: 'prefer_100_percent_hot_drama_recordings',
    evidence_scope: 'frozen_window_identity_declarations_only',
    audio_listened: false, source_identity_approved: false, plot_applicability_assessed: false,
    current_adoption_allowed: false, qualification_granted: false, production_approval: false };
  if (result.blocked) {
    result.gaps = ['frozen_case_library_has_no_reference_recording_window', 'hot_drama_minimum_70_percent_required'];
    result.next_action = 'retrieve_and_bind_plot_compatible_hot_drama_recordings';
  }
  const receipt = await saveJson(path.join(out, 'reference-music-supply.json'), result);
  return { ...result, receipt };
}

function inferredIndependentSources(plan, routes) {
  const candidates = (routes?.routes ?? []).flatMap(route => route.source_candidates ?? []);
  return { schema_version: 1, sources: plan.assets.filter(asset => plan.cues.some(cue => cue.track === 'bgm'
    && cue.asset_id === asset.id)).map(asset => {
    const candidate = candidates.find(row => row.asset_id === asset.id && row.source_sha256 === asset.sha256) ?? asset;
    return { asset_id: asset.id, source_sha256: asset.sha256,
      origin: candidate.origin ?? candidate.source_origin ?? 'unknown',
      pack_id: candidate.pack_id, window_id: candidate.window_id, preset_id: candidate.preset_id,
      window_binding: candidate.window_binding };
  }) };
}

// Resolve original-use candidates from the actual recalled case pool. Artistic approval stays separate.
async function inferredSources(config, plan, caseRoutes) {
  const databasePath = config.cases?.db;
  const candidates = (caseRoutes?.routes ?? []).flatMap(route => (route.source_candidates ?? []).map(candidate => ({ route, candidate })));
  const rows = plan.assets.filter(asset => plan.cues.some(cue => cue.track === 'bgm' && cue.asset_id === asset.id)).map(asset => {
    const hit = candidates.find(({ candidate }) => candidate.asset_id === asset.id
      && candidate.source_sha256 === asset.sha256 && isOriginalRecordingRelation(candidate.source_relation)
      && candidate.original_recording_evidence);
    const caseId = hit?.candidate.case_id ?? hit?.route.case_ids?.[0];
    return { asset, hit, caseId };
  });
  let database, cases = new Map();
  const ids = [...new Set(rows.filter(row => row.caseId).map(row => row.caseId))];
  if (databasePath && ids.length) {
    database = { path: path.resolve(databasePath), sha256: await hashFile(databasePath) };
    const script = 'import sys,json,sqlite3,pathlib,hashlib\n'
      + 'db=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True)\n'
      + 'result=[]\n'
      + 'for case_id in json.loads(sys.argv[2]):\n'
      + ' row=db.execute("SELECT record_json FROM cases WHERE case_id=?",(case_id,)).fetchone()\n'
      + ' if row: result.append({"case_id":case_id,"record_sha256":hashlib.sha256(row[0].encode()).hexdigest()})\n'
      + 'print(json.dumps(result))\n';
    const result = await execute(config.python || 'python', ['-X','utf8','-c',script,database.path,JSON.stringify(ids)],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    await verifyEvidenceBindings(database);
    cases = new Map(JSON.parse(result.stdout).map(row => [row.case_id, { database, ...row }]));
  }
  const sources = [];
  for (const { asset, hit, caseId } of rows) {
    const source = { asset_id: asset.id, source_sha256: asset.sha256, origin: 'unknown' };
    if (hit && cases.has(caseId)) {
      await verifyEvidenceBindings(hit.candidate.original_recording_evidence);
      const identity = await readJson(hit.candidate.original_recording_evidence.path);
      Object.assign(source, { origin: 'hot_drama', reference_case_binding: cases.get(caseId),
        identity: { support_range: identity.source_range, original_recording_evidence: hit.candidate.original_recording_evidence,
          ...(hit.candidate.source_relation === 'reviewed_same_recording_window' ? {
            source_relation: hit.candidate.source_relation, reference_case_use_range: identity.reference_case_use_range,
            reference_use_source_range: identity.source_range, ready_source_range: hit.candidate.ready_source_range,
            human_review_record: hit.candidate.human_review_record } : {}) } });
    }
    sources.push(source);
  }
  return { schema_version: 1, sources };
}

// Default delivery keeps the user's 70% floor. Independent diagnostic trials use a separate scoped policy.
export async function enforceEpisodeMusicSourceBudget({ config, plan, caseRoutes, out, durationSamples }) {
  const sourcePolicy = await validateIndependentMusicPackPolicy(config, { outputDirectory: out });
  const independent = sourcePolicy !== null;
  let raw, input;
  if (config.music_source_provenance) {
    if (!path.isAbsolute(config.music_source_provenance.path ?? '')
      || !/^[a-f0-9]{64}$/.test(config.music_source_provenance.sha256 ?? ''))
      throw new Error('music_source_provenance_binding_required');
    await verifyEvidenceBindings(config.music_source_provenance);
    raw = await readJson(config.music_source_provenance.path); input = config.music_source_provenance;
  } else {
    raw = independent ? inferredIndependentSources(plan, caseRoutes) : await inferredSources(config, plan, caseRoutes);
    input = await saveJson(path.join(out, 'music-source-provenance.json'), raw);
  }
  const options = { duration_samples: durationSamples, plan_directory: out,
    ...(config.python ? {python:config.python} : {}),
    ...(config.music_packs ? {pcm_clock_publication:config.music_packs} : {}),
    pcm_clock_output_directory:path.join(out,'actual-pcm-source-clocks'),
    ...(independent ? { source_policy: sourcePolicy } : {}),
    ...(config.music_source_scope ? { scope: config.music_source_scope } : {}) };
  const verified = await verifyMusicSourceProvenance(plan, raw, options);
  const budget = evaluateMusicSourceBudget(plan, verified, options);
  const minimum = independent ? null : Number((BigInt(budget.total_music_samples) * 70n + 99n) / 100n);
  const result = { ...budget, provenance: input, verified_sources: verified.sources, scope: verified.scope,
    minimum_hot_drama_samples: minimum, hot_drama_deficit_samples: independent ? 0 : Math.max(0, minimum - budget.hot_drama_samples),
    target: independent ? 'independent_music_pack_diagnostic_trial' : 'prefer_100_percent_hot_drama_recordings',
    diagnostic_candidates_only: independent, reference_route_policy_unchanged: true,
    next_action: budget.passed ? 'continue_plot_and_sound_review' : independent
      ? 'close_independent_pack_source_window_gap' : 'retrieve_and_bind_plot_compatible_hot_drama_recordings',
    caller_supplied_provenance: !!config.music_source_provenance };
  const receipt = await saveJson(path.join(out, 'music-source-budget.json'), result);
  const escape = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
  const rows = plan.cues.filter(cue => cue.track === 'bgm').map(cue => {
    const source = verified.sources.find(row => row.asset_id === cue.asset_id);
    const start = cue.start_seconds ?? cue.sync.target_seconds - cue.sync.source_anchor_seconds + cue.source_in_seconds;
    const end = start + cue.source_out_seconds - cue.source_in_seconds;
    const visibleStart = Math.max(0, start), actualSourceStart = cue.source_in_seconds + visibleStart - start;
    const category = source?.budget_origin === 'hot_drama' ? '热门短剧实证原录音' : independent
      ? `${escape(source?.declared_origin)}／待审诊断窗` : '辅助／来源未核';
    return `| ${visibleStart.toFixed(3)}–${end.toFixed(3)}秒 | ${escape(cue.asset_id)} | ${category} | ${escape(source?.reference?.title ?? (independent ? source?.pack_id : '未建立热门短剧原用曲关联'))} | ${escape(source?.reference?.episode_position ?? source?.window_id ?? '—')} | ${actualSourceStart.toFixed(3)}–${cue.source_out_seconds.toFixed(3)}秒 |`;
  });
  const ledger = path.join(out, 'music-source-ledger.md');
  const heading = independent
    ? '独立音乐包诊断试听；本次不设热门短剧来源最低比例。旧原曲路线的70%门槛保持。\n\n真实文件与冻结源窗检查：'
      + `${budget.passed ? '通过' : '未通过'}。材料、唱词、用途及成片仍待独立试听认可；不授予生产资格。`
    : `目标100%实证热门短剧来源，最低70%；辅助最多30%。\n\n实证来源：${budget.hot_drama_percent.toFixed(6)}%；辅助／未核：${budget.auxiliary_percent.toFixed(6)}%。来源门槛：${budget.passed ? '通过' : '未通过'}。至少还缺${result.hot_drama_deficit_samples}个参考样本（${(result.hot_drama_deficit_samples / 48000).toFixed(6)}秒）。`;
  await writeFile(ledger, `# 本集配乐来源账单\n\n${heading}\n\n按新增音乐时间线并集统计；原声不计入新增音乐来源。来源通过不代替剧情适配、歌句及听感验收。\n\n| 本片播放区间 | 录音ID | 来源归类 | 来源短剧／音乐包 | 来源集位／窗口 | 使用录音源窗 |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n精确身份、源窗及证据见同目录music-source-budget.json。\n`, 'utf8');
  return { ...result, receipt, source_ledger: { path: ledger, sha256: await hashFile(ledger) } };
}
