import io, os, sys, unittest
from unittest.mock import patch
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'runtime'))
import diag

class Clock:
    def __init__(self): self.t = 1000.0
    def __call__(self): return self.t
    def advance(self, s): self.t += s

class ThreadChoice(unittest.TestCase):
    def test_explicit_setting_wins(self):
        self.assertEqual(diag.auto_threads({'STREAM_FFMPEG_THREADS': '3'}), (3, 'STREAM_FFMPEG_THREADS'))
    def test_threads_follow_cpu_quota_not_the_host_core_count(self):
        with patch.object(diag, 'cpu_quota_cores', return_value=0.5):
            self.assertEqual(diag.auto_threads({})[0], 1)
        with patch.object(diag, 'cpu_quota_cores', return_value=2.0):
            self.assertEqual(diag.auto_threads({})[0], 2)
        with patch.object(diag, 'cpu_quota_cores', return_value=32.0):
            self.assertEqual(diag.auto_threads({})[0], 4)      # never more than 4 for one 720p encode
        with patch.object(diag, 'cpu_quota_cores', return_value=None):
            self.assertEqual(diag.auto_threads({})[0], 2)
    def test_invalid_value_falls_back_to_auto(self):
        with patch.object(diag, 'cpu_quota_cores', return_value=1.0):
            self.assertEqual(diag.auto_threads({'STREAM_FFMPEG_THREADS': 'lots'})[0], 1)

class Stats(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.events = []
        p = patch.object(diag.time, 'monotonic', self.clock); p.start(); self.addCleanup(p.stop)
        self.stats = diag.PlaybackStats(lambda name, **f: self.events.append((name, f)), interval=10.0)
        self.stats.reset({'cid': 'c1', 'gen': 3}, fps=24, bitrate_kbps=3500)

    def send(self, n, dt=1 / 24):
        for _ in range(n):
            self.stats.on_video_received(); self.stats.on_video_sent(); self.clock.advance(dt)

    def test_first_video_and_audio_are_reported_once_with_correlation_id(self):
        self.clock.advance(1.5); self.stats.on_video_sent(); self.stats.on_video_sent()
        self.stats.on_audio_packet(); self.stats.on_audio_packet()
        names = [e[0] for e in self.events]
        self.assertEqual(names.count('first_video_sent'), 1); self.assertEqual(names.count('first_audio_sent'), 1)
        first = dict(self.events)['first_video_sent']
        self.assertEqual(first['cid'], 'c1'); self.assertEqual(first['since_play_ms'], 1500)

    def test_smooth_playback_has_no_stall_time(self):
        self.send(24 * 5)
        s = self.stats.flush()
        self.assertEqual(s['video']['stalls'], 0); self.assertEqual(s['video']['stall_ms'], 0)
        self.assertEqual(s['video']['frames_sent'], 120); self.assertAlmostEqual(s['video']['fps_sent'], 24, delta=1)

    def test_a_freeze_is_counted_once_even_when_summaries_happen_during_it(self):
        self.send(24)
        self.clock.advance(3.0)                       # nothing is sent for 3 s
        during = self.stats.flush()                   # a summary lands in the middle of the freeze
        self.assertGreater(during['video']['stall_ms'], 2500)
        self.clock.advance(1.0)
        self.send(1)                                  # video resumes
        after = self.stats.flush()
        total = during['video']['stall_ms'] + after['video']['stall_ms']
        self.assertAlmostEqual(total, 4000 - 42, delta=120)     # 4 s freeze minus one frame interval, not double counted
        self.assertEqual(during['video']['stalls'] + after['video']['stalls'], 1)

    def test_unknown_values_stay_null_and_late_frames_are_not_called_lost(self):
        self.send(10)
        v = self.stats.flush()['video']
        self.assertIsNone(v['frames_dropped']); self.assertIsNone(v['frames_duplicated']); self.assertIsNone(v['encoder_speed'])
        self.assertNotIn('lost', ' '.join(v.keys()))

    def test_skipped_frames_are_counted_by_reason(self):
        self.stats.on_video_skipped('nal_guard'); self.stats.on_video_skipped('nal_guard'); self.stats.on_video_skipped('send_error')
        self.assertEqual(self.stats.flush()['video']['frames_skipped'], {'nal_guard': 2, 'send_error': 1})

    def test_summary_is_emitted_every_ten_seconds_and_every_second_in_debug(self):
        self.send(24 * 12)
        self.assertEqual(sum(1 for e in self.events if e[0] == 'stats'), 1)
        self.stats.set_debug(5)
        before = sum(1 for e in self.events if e[0] == 'stats')
        self.send(24 * 3)
        self.assertGreaterEqual(sum(1 for e in self.events if e[0] == 'stats') - before, 2)

    def test_ticker_reports_a_total_freeze_but_stays_quiet_when_nothing_plays(self):
        self.send(24)
        self.clock.advance(11); self.stats.tick()
        self.assertTrue(any(e[0] == 'stats' for e in self.events))
        n = len(self.events); self.clock.advance(60); self.stats.tick(); self.stats.tick()
        self.assertLessEqual(len(self.events) - n, 1)      # idle for over 45 s: no more reports

    def test_audio_underruns_and_short_reads_are_counted(self):
        self.send(5)
        self.stats.on_pcm_read(0.001, 3840, 3840); self.stats.on_pcm_read(0.080, 3840, 3840); self.stats.on_pcm_read(0.001, 3840, 1200)
        a = self.stats.flush()['audio']
        self.assertEqual((a['pcm_reads'], a['pcm_underruns'], a['pcm_short_reads']), (3, 1, 1))

    def test_output_has_no_secrets_and_a_readable_line(self):
        self.send(30)
        s = self.stats.flush()
        text = diag.readable(s)
        self.assertIn('fps', text); self.assertNotIn('http', text); self.assertLess(len(text), 400)

class Reader(unittest.TestCase):
    def test_timed_reader_reports_wait_and_size_and_passes_data_through(self):
        seen = []
        r = diag.TimedReader(io.BytesIO(b'x' * 100), lambda w, n, req: seen.append((n, req)))
        self.assertEqual(len(r.read(64)), 64); self.assertEqual(len(r.read(64)), 36)
        self.assertEqual(seen, [(64, 64), (36, 64)])

if __name__ == '__main__':
    unittest.main()
