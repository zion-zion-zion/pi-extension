#!/usr/bin/env python3
"""Manual Kitty background-layer probe; never changes Pi or Herdr settings."""
import argparse
import base64
import io
import json
import os
from pathlib import Path
import re
import select
import sys
import termios
import time
import tty

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.local-tests' / 'rounded-bubble-probe'
# Per-process IDs avoid deleting another app's images.
BASE_ID = 1000000 + os.getpid() * 4
IDS = (BASE_ID, BASE_ID + 1)
ESC = '\x1b'


def rounded_png(width, height):
    scale = 3
    image = Image.new('RGBA', (width * scale, height * scale), (0, 0, 0, 0))
    ImageDraw.Draw(image).rounded_rectangle(
        (0, 0, image.width - 1, image.height - 1),
        radius=min(24, height // 3) * scale, fill=(232, 232, 232, 255))
    image = image.resize((width, height), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return buffer.getvalue()


def emit(value):
    sys.stdout.write(value)
    sys.stdout.flush()


def read_reply(timeout):
    deadline = time.monotonic() + timeout
    result = b''
    while time.monotonic() < deadline:
        ready, _, _ = select.select([sys.stdin], [], [], max(0, deadline - time.monotonic()))
        if not ready:
            break
        result += os.read(sys.stdin.fileno(), 65536)
        # Collect multiple reports, with a short quiet period after each chunk.
        if not select.select([sys.stdin], [], [], 0.1)[0]:
            break
    return result.decode('utf-8', errors='replace')


def kitty(control, payload=''):
    return f'{ESC}_G{control};{payload}{ESC}\\'


def delete_images():
    for image_id in IDS:
        emit(kitty(f'a=d,d=I,i={image_id},q=2'))


def place(png, image_id, row, columns, rows, z):
    emit(f'{ESC}[{row};3H')
    data = base64.b64encode(png).decode('ascii')
    for start in range(0, len(data), 4096):
        chunk = data[start:start + 4096]
        more = int(start + 4096 < len(data))
        control = (f'a=T,f=100,i={image_id},c={columns},r={rows},z={z},C=1,q=2,m={more}'
                   if start == 0 else f'm={more}')
        emit(kitty(control, chunk))


def write_at(row, column, text):
    emit(f'{ESC}[{row};{column}H{text}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--self-test', action='store_true')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    png = rounded_png(480, 120)
    (OUT / 'rounded-background.png').write_bytes(png)
    if args.self_test:
        with Image.open(io.BytesIO(png)) as image:
            assert image.mode == 'RGBA'
            assert image.getpixel((0, 0))[3] == 0
            assert image.getpixel((240, 60)) == (232, 232, 232, 255)
        print('PNG alpha/center checks passed; bytes:', len(png))
        return
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise SystemExit('Run this probe in its own interactive terminal pane.')
    original = termios.tcgetattr(sys.stdin)
    log = {'pid': os.getpid(), 'image_ids': IDS}
    try:
        tty.setraw(sys.stdin.fileno())
        emit(f'{ESC}[?1049h{ESC}[?25l{ESC}[2J')
        emit(f'{ESC}[16t')
        cell_reply = read_reply(1.5)
        log['cell_reply'] = repr(cell_reply)
        match = re.search(r'\x1b\[6;(\d+);(\d+)t', cell_reply)
        cell_h, cell_w = (int(match[1]), int(match[2])) if match else (20, 10)
        if cell_h < 1 or cell_w < 1:
            cell_h, cell_w, match = 20, 10, None
        # Query uses a separate id, never places an image.
        query_png = rounded_png(4, 4)
        emit(kitty(f'a=q,t=d,f=100,i={BASE_ID + 2}', base64.b64encode(query_png).decode('ascii')))
        log['kitty_query_reply'] = repr(read_reply(2))
        cols, terminal_rows = os.get_terminal_size()
        width = max(8, min(60, cols - 5))
        rows = max(2, min(5, (terminal_rows - 8) // 2))
        log.update(cell_width=cell_w, cell_height=cell_h, cell_size_measured=bool(match),
                   columns=width, rows=rows)
        png = rounded_png(width * cell_w, rows * cell_h)
        (OUT / 'rounded-background.png').write_bytes(png)

        def draw():
            delete_images()
            emit(f'{ESC}[0m{ESC}[2J{ESC}[H')
            write_at(1, 2, 'Rounded bubble probe | r redraw | s scroll up 2 rows | q quit')
            write_at(2, 2, 'A: PNG control (should have smooth, transparent corners)')
            place(png, IDS[0], 3, width, rows, 1)
            label_row = 4 + rows
            write_at(label_row, 2, 'B: SAME PNG behind selectable terminal text (z=-1)')
            place(png, IDS[1], label_row + 1, width, rows, -1)
            write_at(label_row + 2, 5, f'{ESC}[30mNative text: 123 ABC  /  原生中文圆角背景{ESC}[39m')
            write_at(label_row + 3, 5, f'{ESC}[30mSelect this line with your terminal mouse.{ESC}[39m')
            status_row = min(terminal_rows, label_row + rows + 2)
            write_at(status_row, 2, f'Cell pixels: {cell_w}x{cell_h} ({"reported" if match else "ESTIMATED"})')

        draw()
        log['status'] = 'displayed; visual confirmation required'
        (OUT / 'probe.json').write_text(json.dumps(log, indent=2))
        while True:
            key = os.read(sys.stdin.fileno(), 1)
            if key in (b'q', b'\x03', b'\x04'):
                break
            if key == b'r':
                draw()
            elif key == b's':
                emit(f'{ESC}[2S')
                log['scroll_test_requested'] = True
                (OUT / 'probe.json').write_text(json.dumps(log, indent=2))
    finally:
        delete_images()
        emit(f'{ESC}[0m{ESC}[?25h{ESC}[?1049l')
        termios.tcsetattr(sys.stdin, termios.TCSADRAIN, original)
    print('Probe closed; images cleaned up. Log:', OUT / 'probe.json')


if __name__ == '__main__':
    main()
