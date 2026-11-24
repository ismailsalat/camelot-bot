"""Keep unsafe H.264 data away from Discord's DAVE encryption library.

libdave (the native encryption library) parses each H.264 slice header itself. Measured with a real
two-member DAVE group (tests/dave_rig.py):
  * a slice NAL shorter than 5 bytes that is not the first slice of its picture corrupts the heap
    ("Frame is too small to contain the encrypted frame", then SIGABRT, which kills the whole streamer);
  * a frame with about 24 or more NAL units overruns an internal buffer the same way.
The video player flushes a half-read NAL when FFmpeg is stopped, and multi-slice encodes make tiny slices
common, so the crash showed up right when playback switched from the standby slate to an episode.
"""
from __future__ import annotations

SLICE_TYPES = (1, 5)
PARAM_TYPES = (6, 7, 8)
MIN_SLICE_BYTES = 6   # NAL header + at least 5 bytes; libdave misbehaves below 5
MAX_NALS = 16         # libdave overruns its buffer near 24; stay well under


def nal_type(nal: bytes) -> int:
    return nal[0] & 0x1F if nal else -1


def sanitize(nal_units: list[bytes]) -> tuple[list[bytes], list[str]]:
    """Return (safe NAL units, reasons for anything dropped). An empty list means: skip this frame."""
    safe: list[bytes] = []
    problems: list[str] = []
    dropped_slice = False
    for nal in nal_units:
        t = nal_type(nal)
        if len(nal) < 2:
            problems.append('empty NAL')
        elif t in SLICE_TYPES:
            if len(nal) < MIN_SLICE_BYTES:
                problems.append(f'tiny slice ({len(nal)} bytes)')
                dropped_slice = True
            else:
                safe.append(nal)
        elif t in PARAM_TYPES:
            safe.append(nal)
        else:
            problems.append(f'unexpected NAL type {t}')
    if len(safe) > MAX_NALS:
        problems.append(f'{len(safe)} NAL units in one frame')
        safe = safe[:MAX_NALS]
    if dropped_slice and not any(nal_type(n) in SLICE_TYPES for n in safe):
        return [], problems  # nothing to show for this picture; skip it rather than send headers alone
    return safe, problems
