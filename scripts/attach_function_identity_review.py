"""Attach existing real original-drama comparison media to a pending batch.

No audio decode, model, HTTP, identity approval or publisher call is made. This
copies already generated audio bytes (SHA-verified) for a local review page. The
original mix is labelled separately and never added to a clean music library.
"""
import argparse
import html
import json
from pathlib import Path
import shutil

import bridge_original_candidates as bridge


def attach(root, package_binding, assets_binding):
    root = Path(root)
    package_path = bridge.verify(package_binding)
    package = json.loads(Path(package_path['path']).read_text(encoding='utf-8-sig'))
    assets = json.loads(Path(bridge.verify(assets_binding)['path']).read_text(encoding='utf-8-sig'))
    known = {row['source_sha256'] for row in assets['assets']}
    if package.get('actual_audio_listened') is not False or package.get('identity_approved') is not False:
        raise ValueError('pending_actual_identity_package_required')
    destination = root / 'identity-audio'; destination.mkdir(exist_ok=False)
    copied, sections = [], []
    for comparison in package['comparisons']:
        if comparison['same_recording_version'] is not None or comparison['Ready'] is not False:
            raise ValueError('do_not_rewrite_approved_identity_or_infer_ready')
        key = comparison['comparison_id']
        reference = comparison['reference_original']
        section = [f'<article><h2>{html.escape(comparison["title_metadata_only"])}</h2>',
            f'<p>实际原剧音频窗 {reference["actual_range_seconds"]} / SHA {reference["source"]["sha256"]}。对白保留，16k 单声道转换明示；未调速/调音高。</p>']
        channels = [('reference', reference['audio'])]
        for number, candidate in enumerate(comparison['candidates']):
            independent = candidate['independent_recording']
            if independent['source']['sha256'] not in known:
                raise ValueError('independent_source_not_in_bound_full12')
            if independent['speed_changed'] or independent['pitch_changed']:
                raise ValueError('identity_review_must_preserve_speed_and_pitch')
            channels += [(f'independent-{number}', independent['audio']), (f'paired-{number}', candidate['synchronous_stereo'])]
            section.append(f'<p>独立录音候选 {number+1}：源 {independent["actual_range_seconds"]} / SHA {independent["source"]["sha256"]}；{html.escape(candidate["position_status"])}。</p>')
        bindings = []
        for kind, reference_binding in channels:
            source = bridge.verify(reference_binding)
            target = destination / f'{key}-{kind}.wav'
            shutil.copyfile(source['path'], target)
            actual = bridge.binding(target)
            if actual['sha256'] != reference_binding['sha256']:
                raise ValueError('copied_identity_audio_changed')
            bindings.append({'role': kind, 'upstream': reference_binding, 'local': actual})
            section += [f'<p>{html.escape(kind)}'+('：左原剧混音 / 右独立录音' if kind.startswith('paired') else '')+'</p>',
                        f'<audio controls preload="none" src="identity-audio/{target.name}"></audio>']
        section += ['<label>听后同版本判断 <select><option>待听/不确定</option><option>这些精确窗为同录音同版本</option><option>同旋律但不同/不确定版本</option><option>不同录音</option></select></label>',
                    '<p>这是原用曲身份待审；不能批准整曲词句、干净度、九片用途或 Ready。</p>',
                    f'<details><summary>真实 case/event 交集与机器核验指针</summary><pre>{html.escape(json.dumps({"case_events":comparison["actual_case_event_candidates"],"machine_probe":comparison["machine_probe"]},ensure_ascii=False,indent=2))}</pre></details></article>']
        copied.append({'comparison_id': key, 'media': bindings,
                       'reference_original': reference, 'candidates': comparison['candidates'],
                       'actual_case_event_candidates': comparison['actual_case_event_candidates'],
                       'machine_probe': comparison['machine_probe'], 'same_recording_version': None,
                       'actual_audio_listened': False, 'identity_approved': False, 'Ready': False})
        sections.append('\n'.join(section))
    sidecar = bridge.save(root / 'original-drama-comparisons.json', {'schema_version': 1,
                 'status': 'actual_original_comparison_media_pending_human_identity', 'upstream': package_binding,
                 'full12': assets_binding, 'comparisons': copied, 'original_mix_is_not_clean_music_supply': True,
                 'Ready': False, 'actual_audio_listened': False})
    document = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>原剧与独立录音对照</title><style>body{max-width:960px;margin:24px auto;background:#111922;color:#eee;font:16px/1.6 sans-serif;padding:18px}article{padding:18px;border:1px solid #556;margin:20px 0}audio{width:100%}pre{white-space:pre-wrap;overflow-wrap:anywhere}select{font:inherit}</style><h1>原剧与独立录音对照 · 身份待核</h1><p>真实原声与独立录音，供听后核相同录音版本。选择框只是本地判断草稿，不会发布身份。仅相同旋律、较高相关度或相同歌名都不能自动通过。</p><a href="index.html">返回音乐与音效批审核</a>' + '\n'.join(sections) + '</html>'
    (root / 'identity.html').write_text(document, encoding='utf-8')
    return sidecar


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--root', required=True)
    parser.add_argument('--package', required=True); parser.add_argument('--assets', required=True)
    args = parser.parse_args()
    print(json.dumps(attach(args.root, bridge.binding(args.package), bridge.binding(args.assets)), ensure_ascii=False))
