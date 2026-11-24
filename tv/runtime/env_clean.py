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

def report(fixes: list[str]) -> None:
    for line in fixes:
        print(f'WARNING env_clean Setting fixed: {line}', file=sys.stderr, flush=True)
