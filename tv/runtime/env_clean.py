"""Clean STREAM_* settings before FFmpeg sees them.

Hosting dashboards often keep stray quotes or spaces (e.g. STREAM_VIDEO_BITRATE=6000k'). FFmpeg then
refuses to open the encoder and every video fails. Mirrors tv/src/envclean.mjs."""
from __future__ import annotations
import os, re, sys

PRESETS = {'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'}
BITRATE = re.compile(r'^\d{3,5}[kKmM]$')
_STRIP = " \t\r\n'\"`"

def _bitrate_ok(v: str) -> bool:
    return bool(BITRATE.match(v)) and int(v[:-1]) <= (50 if v[-1] in 'mM' else 50000)

RULES = {
    'STREAM_VIDEO_BITRATE': (_bitrate_ok, None),
    'STREAM_RESOLUTION': (lambda v: bool(re.fullmatch(r'\d{3,4}[:x]\d{3,4}', v)), lambda v: v.replace('x', ':')),
    'STREAM_FPS': (lambda v: bool(re.fullmatch(r'\d{1,2}(\.\d+)?', v)) and 1 <= float(v) <= 60, None),
    'STREAM_X264_PRESET': (lambda v: v.lower() in PRESETS, str.lower),
    'STREAM_FFMPEG_THREADS': (lambda v: bool(re.fullmatch(r'\d{1,2}', v)) and 1 <= int(v) <= 16, None),
    'STREAM_QUALITY': (lambda v: v.lower() in {'720p', '1080p', '4k'}, str.lower),
}

def clean_stream_env(environ=None) -> list[str]:
    """Fix or remove invalid STREAM_* values in place. Returns a human-readable list of what changed."""
    env = os.environ if environ is None else environ
    fixes: list[str] = []
    for name, (ok, norm) in RULES.items():
        if name not in env:
            continue
        raw = env[name]
        value = raw.strip(_STRIP)
        if not ok(value):
            fixes.append(f'{name}={raw!r} is not valid; ignoring it and using the default')
            del env[name]
            continue
        value = norm(value) if norm else value
        if value != raw:
            fixes.append(f'{name}={raw!r} had stray quotes or spaces; using {value}')
        env[name] = value
    return fixes

def safe_bitrate_args(cmd: list[str], default: str = '6000k') -> list[str]:
    """Last line of defence: replace any malformed -b:v/-maxrate/-bufsize value in a finished FFmpeg command."""
    bad = []
    for flag in ('-b:v', '-maxrate', '-bufsize'):
        for i, item in enumerate(cmd[:-1]):
            if item == flag and not _bitrate_ok(cmd[i + 1]):
                bad.append(f'{flag} {cmd[i + 1]!r}')
                cmd[i + 1] = default
    return bad

def _kbps(v: str) -> int:
    return int(v[:-1]) * (1000 if v[-1] in 'mM' else 1)

def cap_bitrate_args(cmd: list[str], environ=None) -> list[str]:
    """Keep the video bitrate and rate-control buffer in a range Discord can relay smoothly.

    Discord drops or stalls video that arrives faster than its relay accepts, which shows up as freezes that
    start a few seconds after a smooth beginning. 720p anime looks the same at ~3.5 Mbps as at 10 Mbps, and a
    sub-half-second buffer keeps keyframes from arriving as one giant burst. STREAM_ALLOW_HIGH_BITRATE=1 opts out."""
    env = os.environ if environ is None else environ
    notes: list[str] = []
    height = 720
    if '-vf' in cmd:
        m = re.search(r'scale=(\d+):(\d+)', cmd[cmd.index('-vf') + 1])
        if m:
            height = int(m.group(2))
    limit = 3500 if height <= 720 else 6000 if height <= 1080 else None
    allow = env.get('STREAM_ALLOW_HIGH_BITRATE', '').strip() == '1'
    rate = None
    for flag in ('-b:v', '-maxrate'):
        if flag in cmd[:-1]:
            i = cmd.index(flag) + 1
            if _bitrate_ok(cmd[i]):
                k = _kbps(cmd[i])
                if limit and not allow and k > limit:
                    notes.append(f'{flag} {cmd[i]} lowered to {limit}k')
                    k = limit
                    cmd[i] = f'{k}k'
                rate = k if rate is None else min(rate, k)
    if rate and '-bufsize' in cmd[:-1]:
        i = cmd.index('-bufsize') + 1
        want = f'{max(500, rate * 2 // 5)}k'
        if cmd[i] != want:
            cmd[i] = want
            notes.append(f'-bufsize set to {want}')
    return notes

def report(fixes: list[str]) -> None:
    for line in fixes:
        print(f'WARNING env_clean Setting fixed: {line}', file=sys.stderr, flush=True)
