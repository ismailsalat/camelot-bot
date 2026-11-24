"""Playback diagnostics for the Go Live worker. Everything here is measured inside this process.

Nothing in this file claims what the viewer sees: "sent" means handed to the local UDP socket. Metrics that cannot be
measured are reported as None, never guessed.
"""
from __future__ import annotations
import collections, fcntl, json, os, struct, termios, threading, time
from pathlib import Path

SCHEMA = 1
FRAME_THRESHOLDS_MS = (25, 50, 100, 250, 1000)   # how far past one frame interval a gap went

def _read(path, default=None):
    try:
        return Path(path).read_text().strip()
    except OSError:
        return default

def _kv(path):
    out = {}
    text = _read(path, '')
    for line in text.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].lstrip('-').isdigit():
            out[parts[0]] = int(parts[1])
    return out

# ── CPU quota / throttling / memory (cgroup v2 first, then v1) ─────────────────────────────────────────────
def cpu_quota_cores():
    """CPU cores this container may really use (cgroup quota capped by affinity), or None when unknown."""
    cores = None
    raw = _read('/sys/fs/cgroup/cpu.max')
    if raw:
        quota, _, period = raw.partition(' ')
        if quota != 'max' and quota.isdigit() and period.isdigit() and int(period) > 0:
            cores = int(quota) / int(period)
    else:
        quota, period = _read('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'), _read('/sys/fs/cgroup/cpu/cpu.cfs_period_us')
        if quota and period and quota.lstrip('-').isdigit() and period.isdigit() and int(quota) > 0 and int(period) > 0:
            cores = int(quota) / int(period)
    try:
        affinity = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        affinity = os.cpu_count() or None
    if cores is None:
        return float(affinity) if affinity else None
    return min(cores, affinity) if affinity else cores

def auto_threads(environ=None):
    """Encoder/decoder threads. More threads than CPU quota makes FFmpeg burn the quota in a burst and then freeze
    until the next accounting period (measured: 4 threads on a 0.5-core quota froze the picture 18% of the time,
    1 thread 1.6%)."""
    env = os.environ if environ is None else environ
    raw = str(env.get('STREAM_FFMPEG_THREADS', '')).strip()
    if raw.isdigit() and 1 <= int(raw) <= 16:
        return int(raw), 'STREAM_FFMPEG_THREADS'
    cores = cpu_quota_cores()
    if cores is None:
        return 2, 'default (CPU quota unknown)'
    return max(1, min(4, int(cores + 0.25))), f'auto from CPU quota {cores:.2f}'

def cgroup_sample():
    """Cumulative counters; callers subtract two samples."""
    s = {'t': time.monotonic()}
    v2 = _kv('/sys/fs/cgroup/cpu.stat')
    if v2:
        s.update(cpu_usage_us=v2.get('usage_usec'), throttled_periods=v2.get('nr_throttled'), periods=v2.get('nr_periods'),
                 throttled_us=v2.get('throttled_usec'))
        mem = _read('/sys/fs/cgroup/memory.current')
        limit = _read('/sys/fs/cgroup/memory.max')
        events = _kv('/sys/fs/cgroup/memory.events')
        s.update(mem_bytes=int(mem) if mem and mem.isdigit() else None,
                 mem_limit=int(limit) if limit and limit.isdigit() else None, oom_kills=events.get('oom_kill'))
    else:
        v1 = _kv('/sys/fs/cgroup/cpu/cpu.stat')
        usage = _read('/sys/fs/cgroup/cpuacct/cpuacct.usage')
        s.update(cpu_usage_us=int(usage) // 1000 if usage and usage.isdigit() else None,
                 throttled_periods=v1.get('nr_throttled'), periods=v1.get('nr_periods'),
                 throttled_us=(v1.get('throttled_time') // 1000) if v1.get('throttled_time') is not None else None)
        mem = _read('/sys/fs/cgroup/memory/memory.usage_in_bytes')
        limit = _read('/sys/fs/cgroup/memory/memory.limit_in_bytes')
        oom = _kv('/sys/fs/cgroup/memory/memory.oom_control')
        s.update(mem_bytes=int(mem) if mem and mem.isdigit() else None,
                 mem_limit=int(limit) if limit and limit.isdigit() and int(limit) < 1 << 60 else None,
                 oom_kills=oom.get('oom_kill'))
    return s

def _proc_cpu_seconds(pid):
    """utime+stime of a process in seconds, or None."""
    raw = _read(f'/proc/{pid}/stat')
    if not raw:
        return None
    try:
        fields = raw[raw.rindex(')') + 2:].split()
        return (int(fields[11]) + int(fields[12])) / os.sysconf('SC_CLK_TCK')
    except (ValueError, IndexError):
        return None

def percentile(sorted_values, p):
    if not sorted_values:
        return None
    return sorted_values[min(len(sorted_values) - 1, int(len(sorted_values) * p))]

class TimedReader:
    """Wraps FFmpeg's stdout pipe: times every read and exposes how much video is queued in the pipe."""
    def __init__(self, raw, wait_cb):
        self._raw = raw
        self._wait_cb = wait_cb
    def read(self, n=-1):
        t = time.monotonic()
        data = self._raw.read(n)
        self._wait_cb(time.monotonic() - t, len(data) if data else 0, n)
        return data
    def queued_bytes(self):
        try:
            buf = fcntl.ioctl(self._raw.fileno(), termios.FIONREAD, struct.pack('i', 0))
            return struct.unpack('i', buf)[0]
        except (OSError, ValueError):
            return None
    def __getattr__(self, name):
        return getattr(self._raw, name)

class PlaybackStats:
    """Collects stage counters for one playback generation and turns them into 10 s (or 1 s) summaries."""
    def __init__(self, emit, interval=10.0):
        self.emit = emit
        self.interval = interval
        self.debug_until = 0.0
        self.lock = threading.Lock()
        self.ctx = {}
        self.history = collections.deque(maxlen=120)   # bounded: ~20 min of normal summaries
        self.reset(None)

    # ── life cycle ─────────────────────────────────────────────────────────────────────────────────────
    def reset(self, ctx, fps=None, bitrate_kbps=None):
        with self.lock:
            self.ctx = dict(ctx or {})
            self.fps = fps
            self.bitrate_kbps = bitrate_kbps
            self.started = time.monotonic()
            self.first_video = None
            self.first_audio = None
            self.video_total = 0
            self.audio_total = 0
            self.last_video_t = None
            self.gap_acct = 0.0
            self.last_activity = time.monotonic()
            self.rtp_regressions = 0
            self.last_ts = None
            self._window()
            self.cg0 = cgroup_sample()
            self.ffmpeg_pid = None
            self.ffmpeg_cpu0 = None
            self.worker_cpu0 = time.process_time()
            self.reader = None

    def _window(self):
        self.w_t0 = time.monotonic()
        self.w_gaps = []
        self.w_frames_received = 0
        self.w_frames_sent = 0
        self.w_skipped = collections.Counter()
        self.w_reads = 0
        self.w_read_wait = 0.0
        self.w_read_bytes = 0
        self.w_short_reads = 0
        self.w_audio_packets = 0
        self.w_audio_gaps = []
        self.w_last_audio_t = None
        self.w_pcm_reads = 0
        self.w_pcm_wait = 0.0
        self.w_pcm_short = 0
        self.w_pcm_underruns = 0
        self.w_stalls = 0
        self.w_stall_time = 0.0
        self.w_max_stall = 0.0

    def tick(self):
        """Called about once a second from a background thread, so a total freeze is still reported."""
        now = time.monotonic()
        if now - self.last_activity > 45 or self.first_video is None:
            return
        interval = 1.0 if now < self.debug_until else self.interval
        if now - self.w_t0 >= interval:
            self.flush(now)

    def set_debug(self, seconds):
        self.debug_until = time.monotonic() + seconds if seconds > 0 else 0.0

    def attach_process(self, proc, reader):
        self.ffmpeg_pid = proc.pid
        self.ffmpeg_cpu0 = _proc_cpu_seconds(proc.pid)
        self.reader = reader

    # ── events from the pipeline ───────────────────────────────────────────────────────────────────────────────
    def on_read(self, wait, size, requested):
        with self.lock:
            self.w_reads += 1
            self.w_read_wait += wait
            self.w_read_bytes += size
            if 0 < size < (requested if requested and requested > 0 else 65536):
                self.w_short_reads += 1

    def on_video_received(self):
        with self.lock:
            self.w_frames_received += 1

    def on_video_skipped(self, reason):
        with self.lock:
            self.w_skipped[reason] += 1

    def on_video_sent(self, rtp_ts=None):
        now = time.monotonic()
        first = False
        with self.lock:
            self.video_total += 1
            self.w_frames_sent += 1
            if self.first_video is None:
                self.first_video = now
                first = True
            if self.last_video_t is not None:
                gap = now - self.last_video_t
                self.w_gaps.append(gap)
                interval = 1.0 / self.fps if self.fps else None
                if interval and gap > 1.5 * interval:
                    over = gap - interval
                    if self.gap_acct == 0.0:
                        self.w_stalls += 1
                    self.w_stall_time += max(0.0, over - self.gap_acct)   # a freeze already counted at a flush is not counted twice
                    self.w_max_stall = max(self.w_max_stall, over)
                self.gap_acct = 0.0
            self.last_video_t = now
            self.last_activity = now
            if rtp_ts is not None:
                if self.last_ts is not None and 0 < ((self.last_ts - rtp_ts) & 0xFFFFFFFF) < 0x80000000:
                    self.rtp_regressions += 1
                self.last_ts = rtp_ts
        if first:
            self.emit('first_video_sent', since_play_ms=round((now - self.started) * 1000), **self.ctx)
        self._maybe_flush(now)

    def on_audio_packet(self):
        now = time.monotonic()
        first = False
        with self.lock:
            self.audio_total += 1
            self.w_audio_packets += 1
            if self.first_audio is None:
                self.first_audio = now
                first = True
            if self.w_last_audio_t is not None:
                self.w_audio_gaps.append(now - self.w_last_audio_t)
            self.w_last_audio_t = now
        if first:
            self.emit('first_audio_sent', since_play_ms=round((now - self.started) * 1000), **self.ctx)

    def on_pcm_read(self, wait, wanted, got, frame_ms=20):
        with self.lock:
            self.w_pcm_reads += 1
            self.w_pcm_wait += wait
            if got < wanted:
                self.w_pcm_short += 1
            if wait * 1000 > frame_ms * 1.5:
                self.w_pcm_underruns += 1

    # ── summaries ─────────────────────────────────────────────────────────────────────────────────────────────────
    def _maybe_flush(self, now):
        interval = 1.0 if now < self.debug_until else self.interval
        if now - self.w_t0 >= interval:
            self.flush(now)

    def flush(self, now=None):
        now = now or time.monotonic()
        with self.lock:
            window = max(1e-6, now - self.w_t0)
            gaps = sorted(self.w_gaps)
            interval = 1.0 / self.fps if self.fps else None
            if interval and self.last_video_t is not None and self.first_video is not None:
                open_gap = now - self.last_video_t - interval
                if open_gap > 0.5 * interval:      # nothing was sent for a while: the freeze is still going on
                    if self.gap_acct == 0.0:
                        self.w_stalls += 1
                    self.w_stall_time += max(0.0, open_gap - self.gap_acct)
                    self.w_max_stall = max(self.w_max_stall, open_gap)
                    self.gap_acct = open_gap
            over = {}
            if interval:
                raw = self.w_gaps
                for ms in FRAME_THRESHOLDS_MS:
                    over[f'gaps_over_{ms}ms'] = sum(1 for g in raw if (g - interval) * 1000 > ms)
            queued = self.reader.queued_bytes() if self.reader is not None and hasattr(self.reader, 'queued_bytes') else None
            queued_s = (queued * 8 / (self.bitrate_kbps * 1000)) if (queued is not None and self.bitrate_kbps) else None
            cg = cgroup_sample()
            res = self._resources(cg, window)
            video_media = (self.video_total / self.fps) if (self.fps and self.video_total) else None
            audio_media = self.audio_total * 0.02 if self.audio_total else None
            both = self.first_video and self.first_audio
            summary = {
                'schema': SCHEMA, 'window_s': round(window, 2), **self.ctx,
                'video': {
                    'target_fps': self.fps,
                    'frames_from_ffmpeg': self.w_frames_received, 'frames_sent': self.w_frames_sent,
                    'fps_sent': round(self.w_frames_sent / window, 2),
                    'frames_skipped': dict(self.w_skipped) or {},
                    'frames_dropped': None, 'frames_duplicated': None,   # not observable from this process
                    'gap_ms': {'p50': _ms(percentile(gaps, .5)), 'p95': _ms(percentile(gaps, .95)),
                               'p99': _ms(percentile(gaps, .99)), 'max': _ms(gaps[-1] if gaps else None)},
                    **over,
                    'stalls': self.w_stalls, 'stall_ms': round(self.w_stall_time * 1000),
                    'stall_pct': round(100 * self.w_stall_time / window, 2), 'max_stall_ms': round(self.w_max_stall * 1000),
                    'ffmpeg_read_wait_ms': round(self.w_read_wait * 1000), 'ffmpeg_reads': self.w_reads,
                    'short_reads': self.w_short_reads,
                    'avg_read_bytes': round(self.w_read_bytes / self.w_reads) if self.w_reads else None,
                    'queued_video_ms': round(queued_s * 1000) if queued_s is not None else None,
                    'encoder_speed': None,                                  # needs FFmpeg -progress; not measured
                    'rtp_timestamp_regressions': self.rtp_regressions,
                },
                'audio': {
                    'packets_sent': self.w_audio_packets,
                    'packets_per_s': round(self.w_audio_packets / window, 1),
                    'gap_ms_max': _ms(max(self.w_audio_gaps) if self.w_audio_gaps else None),
                    'pcm_reads': self.w_pcm_reads, 'pcm_wait_ms': round(self.w_pcm_wait * 1000),
                    'pcm_short_reads': self.w_pcm_short, 'pcm_underruns': self.w_pcm_underruns,
                    'queued_audio_ms': None,
                    # Local send timeline only: how far apart the two streams' send clocks are. Not receiver sync.
                    'send_drift_ms': round((video_media - audio_media) * 1000) if (both and video_media and audio_media) else None,
                },
                'resources': res,
            }
            self.history.append(summary)
            self._window()
            self.cg0 = cg
        self.emit('stats', text=readable(summary), **summary)
        return summary

    def _resources(self, cg, window):
        out = {'cpu_quota_cores': cpu_quota_cores(), 'worker_cpu_cores': None, 'ffmpeg_cpu_cores': None, 'container_cpu_cores': None,
               'throttled_periods': None, 'throttled_ms': None, 'mem_mb': None, 'mem_limit_mb': None, 'oom_kills': None}
        c0 = self.cg0 or {}
        dt = max(1e-6, cg['t'] - c0.get('t', cg['t'] - window))
        if cg.get('cpu_usage_us') is not None and c0.get('cpu_usage_us') is not None:
            out['container_cpu_cores'] = round((cg['cpu_usage_us'] - c0['cpu_usage_us']) / 1e6 / dt, 2)
        if cg.get('throttled_periods') is not None and c0.get('throttled_periods') is not None:
            out['throttled_periods'] = cg['throttled_periods'] - c0['throttled_periods']
        if cg.get('throttled_us') is not None and c0.get('throttled_us') is not None:
            out['throttled_ms'] = round((cg['throttled_us'] - c0['throttled_us']) / 1000)
        if cg.get('mem_bytes') is not None:
            out['mem_mb'] = round(cg['mem_bytes'] / 1048576)
        if cg.get('mem_limit'):
            out['mem_limit_mb'] = round(cg['mem_limit'] / 1048576)
        out['oom_kills'] = cg.get('oom_kills')
        now_cpu = time.process_time()
        out['worker_cpu_cores'] = round((now_cpu - self.worker_cpu0) / dt, 2)
        self.worker_cpu0 = now_cpu
        if self.ffmpeg_pid:
            cpu = _proc_cpu_seconds(self.ffmpeg_pid)
            if cpu is not None and self.ffmpeg_cpu0 is not None:
                out['ffmpeg_cpu_cores'] = round((cpu - self.ffmpeg_cpu0) / dt, 2)
                self.ffmpeg_cpu0 = cpu
        return out

def _ms(seconds):
    return None if seconds is None else round(seconds * 1000, 1)

def readable(summary):
    """One short line for the normal log; the full numbers go to the JSONL stream."""
    v, a, r = summary['video'], summary['audio'], summary['resources']
    throttle = f", CPU throttled {r['throttled_ms']} ms" if r.get('throttled_ms') else ''
    cpu = f", ffmpeg {r['ffmpeg_cpu_cores']} cores" if r.get('ffmpeg_cpu_cores') is not None else ''
    return (f"video {v['fps_sent']}/{v['target_fps']} fps sent, frozen {v['stall_ms']} ms ({v['stall_pct']}%, longest {v['max_stall_ms']} ms), "
            f"audio {a['packets_per_s']}/s{', underruns ' + str(a['pcm_underruns']) if a['pcm_underruns'] else ''}{cpu}{throttle}")

def build_info():
    import platform, sys
    info = {'python': sys.version.split()[0], 'platform': platform.platform(), 'commit': os.environ.get('RAILWAY_GIT_COMMIT_SHA', '')[:12] or None,
            'cpu_quota_cores': cpu_quota_cores(), 'cpus_visible': os.cpu_count()}
    try:
        import discord
        info['discord_lib'] = getattr(discord, '__version__', '?')
    except Exception:
        pass
    return info
