import path from 'node:path';
import {isIndependentMusicPackTrial} from './independent_music_policy.mjs';

// A short evidence output root changes neither the source job nor its budget.
// It is deliberately separate from the disposable render/decode cache.
export function validateSfxOfflineRepairRoot(config) {
  if(config.sfx_offline_repair_root===undefined)return undefined;
  if(!isIndependentMusicPackTrial(config)||config.assembly_gap_contract_revision!=='object-scoped-gap-v1'
    ||config.assembly_contract_version!==2)throw Error('sfx_offline_repair_diagnostic_scope_required');
  if(typeof config.sfx_offline_repair_root!=='string'||!path.isAbsolute(config.sfx_offline_repair_root))
    throw Error('sfx_offline_repair_absolute_root_required');
  const root=path.resolve(config.sfx_offline_repair_root),cache=config.render_decode_cache?.root;
  if(cache&&path.isAbsolute(cache)){
    const contains=(a,b)=>{const relative=path.relative(a,b);return relative===''||(!path.isAbsolute(relative)
      &&relative!=='..'&&!relative.startsWith('..'+path.sep));};
    if(contains(root,path.resolve(cache))||contains(path.resolve(cache),root))
      throw Error('sfx_offline_repair_cache_overlap_forbidden');
  }
  return root;
}
