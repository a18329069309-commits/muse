"""Preserve all bound timeline frames in readable, timestamped CLI image sheets."""
import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

LAYOUT_VERSION = 'aspect-preserving-tight-rows-v2'


def digest(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def prepare(input_file, output_dir, columns=3, frames_per_sheet=6):
    source = Path(input_file).resolve()
    data = json.loads(source.read_text(encoding='utf-8-sig'))
    frames = data['frames']
    if (columns, frames_per_sheet) not in ((3, 6), (4, 8), (4, 16), (4, 24)):
        raise ValueError('supported_contact_sheet_layout_required')
    layout_version = {6: LAYOUT_VERSION, 8: 'aspect-preserving-tight-rows-v3-4x2',
                      16: 'aspect-preserving-tight-rows-v4-4x4',
                      24: 'aspect-preserving-tight-rows-v5-4x6'}[frames_per_sheet]
    if not frames:
        raise ValueError('actual_frames_required')
    for frame in frames:
        if digest(frame['path']) != frame['sha256']:
            raise ValueError('source_frame_changed')
    identity = hashlib.sha256(json.dumps(frames, sort_keys=True).encode()).hexdigest()
    out = Path(output_dir).resolve()
    receipt_file = out / 'manifest.json'
    if receipt_file.exists():
        receipt = json.loads(receipt_file.read_text(encoding='utf-8'))
        if receipt['source_frames_sha256'] != identity or receipt.get('layout_version', LAYOUT_VERSION) != layout_version or any(digest(row['path']) != row['sha256'] for row in receipt['frames']):
            raise ValueError('contact_sheet_evidence_changed')
        return receipt
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        raise ValueError('contact_sheet_output_must_be_empty')
    font_file = Path('C:/Windows/Fonts/segoeui.ttf')
    font = ImageFont.truetype(str(font_file), 20) if font_file.exists() else ImageFont.load_default()
    sheets = []
    for start in range(0, len(frames), frames_per_sheet):
        group = frames[start:start + frames_per_sheet]
        thumbs, source_sizes = [], []
        for frame in group:
            with Image.open(frame['path']) as image:
                source_sizes.append(image.size)
                thumbs.append(ImageOps.contain(image.convert('RGB'), (316, 594)))
        row_heights = [max(thumb.height for thumb in thumbs[offset:offset + columns]) + 42
                       for offset in range(0, len(thumbs), columns)]
        sheet = Image.new('RGB', (min(columns, len(group)) * 320, sum(row_heights)), '#111111')
        draw = ImageDraw.Draw(sheet)
        placements = []
        for index, frame in enumerate(group):
            x, y = (index % columns) * 320, sum(row_heights[:index // columns])
            thumb = thumbs[index]
            point = (x + (320 - thumb.width) // 2, y + 34)
            sheet.paste(thumb, point)
            label = f"{frame['id']} | {frame['timeline_seconds']:.3f}s"
            draw.text((x + 5, y + 5), label, font=font, fill='white')
            placements.append({'source_frame_id': frame['id'], 'source_frame_sha256': frame['sha256'],
                               'timeline_seconds': frame['timeline_seconds'], 'x': point[0], 'y': point[1],
                               'width': thumb.width, 'height': thumb.height,
                               'source_width': source_sizes[index][0], 'source_height': source_sizes[index][1]})
        file = out / f'sheet-{len(sheets) + 1:04d}.jpg'
        sheet.save(file, quality=92)
        sheets.append({'path': str(file), 'sha256': digest(file),
                       'source_frame_ids': [row['id'] for row in group],
                       'timeline_seconds': group[0]['timeline_seconds'], 'width': sheet.width, 'height': sheet.height,
                       'placements': placements})
    result = {'schema_version': 1, 'source_frames_sha256': identity, 'source_frame_count': len(frames),
              'layout_version': layout_version,
              'layout': f'up to {columns} columns x {frames_per_sheet // columns} tight rows; aspect-preserving thumbnails; left to right then top to bottom',
              'frames': sheets, 'source_frames': frames,
              'actual_video_processed': False, 'actual_audio_processed': False}
    if frames_per_sheet == 24:
        result['contact_sheet_profile'] = 'continuous-4x6-v1'
        result['model_internal_rescaling_verified'] = False
        result['visual_qualification_granted'] = False
    receipt_file.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--columns', type=int, default=3)
    parser.add_argument('--frames-per-sheet', type=int, default=6)
    args = parser.parse_args()
    result = prepare(args.input, args.output_dir, args.columns, args.frames_per_sheet)
    print(json.dumps({'frame_count': result['source_frame_count'], 'sheet_count': len(result['frames'])}))
