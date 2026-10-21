import { shaBytes } from './audio_api.mjs';

export const directionSoundPropulsionRevision = 'plot-driven-sound-propulsion-v1';
export const directionSoundPropulsionInstruction = ' 声音推力须由当前人物行动、主动权、关系、信息差与观众期待决定，不能把“危险未解除/事实待核”直接等同于慢、低能量、稀疏或泛悬疑。'
  + '事实谨慎与情绪推进分别判断：可呈现受压、对抗尝试、决心、冲击或期待升级，同时不宣称反击获胜、真相揭晓或危机解除。'
  + '在既有music_actions.intent/execution_route.reason和cue.sound_goal中说明声音应如何发展、为何保持或改变；正向audio_retrieval_query体现有依据的律动、密度、声型与动态需求，不只重复restrained/suspense/unresolved。'
  + '一条母cue、同源发展、换源、hold和gain均可采用；连续性不要求全片同曲，切镜/观察窗也不要求换曲。当前情绪可闻的推进不能仅以“更克制/留对白空间”代替，hold/gain须有对应情节理由。'
  + '不强制歌曲数量、风格、能量、音量或人声；局部对白避让由编辑处理。未知音色/乐句/唱词及源内发展仍是待核选材偏好，增益不证明配器变化，不授声音、用途、听审或艺术资格。';

const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const fail = reason => { throw Error('direction_sound_propulsion_' + reason); };

function hostPolicy(sourceSha) {
  return {
    revision: directionSoundPropulsionRevision,
    source_video_sha256: sourceSha,
    planning_scope: 'plot_based_sound_intent_before_material_selection',
    factual_caution_is_not_energy_default: true,
    continuity_is_not_single_recording: true,
    guidance_sha256: shaBytes(directionSoundPropulsionInstruction),
    forced_track_count: false,
    forced_gain_or_energy: false,
    source_facts_approved: false,
    sound_facts_qualified: false,
    lyric_approval: false,
    artistic_approval: false,
    production_approval: false,
  };
}

export function assertDirectionSoundPropulsion(input) {
  const revision = input.data?.direction_sound_propulsion_revision;
  const policy = input.data?.direction_sound_propulsion;
  if (revision === undefined && policy === undefined) return false;
  if (revision !== directionSoundPropulsionRevision
    || !/^[a-f0-9]{64}$/.test(input.data?.source_video_sha256 ?? '')
    || canonical(policy) !== canonical(hostPolicy(input.data.source_video_sha256))) fail('host_policy_changed');
  return true;
}

export function withDirectionSoundPropulsion(input, revision = null) {
  if (revision === null) { assertDirectionSoundPropulsion(input); return input; }
  if (revision !== directionSoundPropulsionRevision || input.stage !== 'research_style_director'
    || input.data?.direction_sound_propulsion_revision !== undefined
    || input.data?.direction_sound_propulsion !== undefined
    || !/^[a-f0-9]{64}$/.test(input.data?.source_video_sha256 ?? '')
    || !input.schema?.properties?.cues || !input.schema?.properties?.music_actions)
    fail('explicit_fresh_direction_request_required');
  const result = structuredClone(input);
  result.data.direction_sound_propulsion_revision = revision;
  result.data.direction_sound_propulsion = hostPolicy(input.data.source_video_sha256);
  result.prompt = (result.prompt ?? '') + directionSoundPropulsionInstruction;
  assertDirectionSoundPropulsion(result);
  return result;
}

export function directionSoundPropulsionInstructionFor(input) {
  return assertDirectionSoundPropulsion(input) ? directionSoundPropulsionInstruction : '';
}
