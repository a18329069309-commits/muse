// Diagnostic comparison breadth changes no source eligibility or listening qualification.
export const independentMusicComparisonRevision='bounded-family-comparison-v1';
const fields=['revision','first_music_family_limit','first_words_family_limit','numeric_low_energy_risk_dbfs'];
export function validateIndependentMusicComparisonPolicy(value){
  if(value===undefined)return null;
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key))
    ||value.revision!==independentMusicComparisonRevision
    ||!['first_music_family_limit','first_words_family_limit'].every(key=>Number.isInteger(value[key])&&value[key]>=2&&value[key]<=5)
    ||!Number.isFinite(value.numeric_low_energy_risk_dbfs)||value.numeric_low_energy_risk_dbfs< -120||value.numeric_low_energy_risk_dbfs>0)
    throw Error('independent_music_comparison_explicit_bounded_policy_required');
  return Object.freeze({...value});
}
export function independentMusicComparisonPolicy(config){
  const value=validateIndependentMusicComparisonPolicy(config?.independent_music_comparison_policy);
  if(value&&config.material_strategy!=='independent_music_packs')throw Error('independent_music_comparison_strategy_required');
  return value;
}
export function firstInspectionFamilyLimit(policy,kind,recallLimit){
  if(!['music','words'].includes(kind)||![20,50].includes(recallLimit))throw Error('independent_music_comparison_round_or_kind_invalid');
  const validated=validateIndependentMusicComparisonPolicy(policy??undefined);
  return recallLimit===50?5:validated?.[kind==='music'?'first_music_family_limit':'first_words_family_limit']??2;
}
export function diagnosticNumericEnergyRisk(rmsDbfs,policy){
  const validated=validateIndependentMusicComparisonPolicy(policy??undefined);if(!validated)return undefined;
  return {threshold_dbfs:validated.numeric_low_energy_risk_dbfs,
    low_energy_risk:Number.isFinite(rmsDbfs)?rmsDbfs<validated.numeric_low_energy_risk_dbfs:null,
    scope:'experimental_numeric_review_hint_not_audibility_or_drama_fit_approval'};
}
export const independentMusicComparisonPrompt=' Inspect every supplied recording family; no extra or permanent reuse ban is introduced. '
  +'numeric_risk is an experimental hint from actual PCM RMS, not heard audibility, LUFS, contamination, a drama-fit veto or approval. '
  +'Consider measured low-energy risk with allowed gain and dialogue masking; preserve uncertainty. Enough source duration does not prove a quiet window is audible.';
