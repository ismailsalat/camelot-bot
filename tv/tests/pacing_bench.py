"""Pacing benchmark: the real H264VideoPlayer + the worker's real FFmpeg command, with the network send replaced by a timestamp recorder.

    taskset -c 0 python pacing_bench.py SOURCE.mp4 --seconds 45 --label baseline

Environment knobs under test: STREAM_SCALE_FLAGS, STREAM_PIPE_KB, STREAM_FPS, STREAM_VIDEO_BITRATE, STREAM_FFMPEG_THREADS.
Prints one JSON line. "stall" time is the NON-overlapping time the picture was frozen: for every gap between two
consecutive sends, the part of the gap beyond 1.5 frame intervals (gaps never overlap, so nothing is counted twice).
Run it under `taskset`/cgroup limits to imitate a small CPU quota; it measures this machine, not Railway.
"""
import argparse, json, logging, os, resource, sys, threading, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
ap = argparse.ArgumentParser()
ap.add_argument('source'); ap.add_argument('--seconds', type=float, default=45); ap.add_argument('--label', default='run')
ap.add_argument('--warmup', type=float, default=6)
ap.add_argument('--diag', action='store_true', help='send through the worker guard + diagnostics and print the 10 s summaries')
args = ap.parse_args()
logging.basicConfig(level=logging.ERROR)
import camelot_worker as w
from streaming.video_player import H264VideoPlayer
from live_session import PCMReader
from types import SimpleNamespace

sends: list[float] = []
sizes: list[int] = []
def record(self, nal_units):
    sends.append(time.monotonic()); sizes.append(sum(len(n) for n in nal_units))
if args.diag:
    w._original_send_frame = record          # the worker's guard and statistics stay in the path
    import contextlib
else:
    H264VideoPlayer._send_frame = record
# Real playback streams from a URL (FFmpeg runs ahead and the Python pacer sets the clock); drop -re used for local files.
orig = H264VideoPlayer._ffmpeg_cmd
def no_re(self):
    cmd = orig(self)
    while '-re' in cmd: cmd.remove('-re')
    return cmd
H264VideoPlayer._ffmpeg_cmd = no_re
vc = SimpleNamespace(ssrc=1, _connection=SimpleNamespace(dave_session=None, mode='bench'))
fps = float(os.environ.get('STREAM_FPS', '24'))
if args.diag:
    w.STATS.reset({'cid': 'bench', 'gen': 1, 'kind': 'bench'}, fps=fps)
player = H264VideoPlayer(str(Path(args.source).resolve()), vc, fps=fps, live=False, audio=True)
w._source_hls[player._url] = False
start_cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
t0 = time.monotonic()
player.start()
reader = PCMReader(player.audio_fifo, player)
def drain():
    while player.is_source_active():
        reader.read(3840)
threading.Thread(target=drain, daemon=True).start()
time.sleep(args.seconds)
player.stop(); player.join(10)
wall = time.monotonic() - t0
end_cpu = resource.getrusage(resource.RUSAGE_CHILDREN)
cpu = (end_cpu.ru_utime - start_cpu.ru_utime) + (end_cpu.ru_stime - start_cpu.ru_stime)
cut = t0 + args.warmup
ts = [x for x in sends if x >= cut]
gaps = sorted(b - a for a, b in zip(ts, ts[1:]))
interval = 1.0 / fps
def pct(p): return round(gaps[min(len(gaps) - 1, int(len(gaps) * p))] * 1000, 1) if gaps else None
raw = [b - a for a, b in zip(ts, ts[1:])]
stall = sum(max(0.0, g - 1.5 * interval) for g in raw)
span = (ts[-1] - ts[0]) if len(ts) > 1 else 0
print(json.dumps({
    'label': args.label, 'cpus': len(os.sched_getaffinity(0)), 'fps_target': fps,
    'fps_actual': round(len(ts) / span, 2) if span else None, 'frames': len(ts),
    'gap_ms': {'p50': pct(.5), 'p95': pct(.95), 'p99': pct(.99), 'max': round(max(raw) * 1000, 1) if raw else None},
    'gaps_over_2x': sum(1 for g in raw if g > 2 * interval), 'gaps_over_100ms': sum(1 for g in raw if g > .1),
    'stall_ms': round(stall * 1000), 'stall_pct_of_time': round(100 * stall / span, 2) if span else None,
    'ffmpeg_cpu_cores': round(cpu / wall, 2), 'pipe': w.PIPE_INFO,
    'kbps': round(sum(sizes[len(sends) - len(ts):]) * 8 / span / 1000) if span else None,
}))
