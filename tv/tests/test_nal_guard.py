"""Guard between the video player and libdave. The integration tests build a real two-member DAVE group
(dave_rig.py) and need dave.py + cryptography + ffmpeg; they are skipped when those are missing."""
import os, shutil, subprocess, sys, textwrap, unittest
from pathlib import Path
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE.parent / 'runtime'))
sys.path.insert(0, str(HERE))
import nal_guard

def nal(t, body): return bytes([0x60 | t]) + body

class SanitizeTests(unittest.TestCase):
    def test_normal_frame_passes_unchanged(self):
        frame = [nal(7, b'x' * 20), nal(8, b'y' * 4), nal(5, b'z' * 3000)]
        safe, problems = nal_guard.sanitize(frame)
        self.assertEqual(safe, frame); self.assertEqual(problems, [])

    def test_tiny_or_cut_off_slice_is_dropped(self):
        for size in (1, 2, 3, 4):
            safe, problems = nal_guard.sanitize([nal(1, b'\x00' * (size - 1) if size > 1 else b'')])
            self.assertEqual(safe, []); self.assertTrue(problems)
        safe, _ = nal_guard.sanitize([nal(1, b'\x9a' * 5)])
        self.assertEqual(len(safe), 1)

    def test_headers_alone_are_not_sent_when_their_slice_was_dropped(self):
        safe, _ = nal_guard.sanitize([nal(7, b'a' * 20), nal(8, b'b' * 4), nal(1, b'\x01\x02')])
        self.assertEqual(safe, [])

    def test_too_many_nal_units_are_capped(self):
        safe, problems = nal_guard.sanitize([nal(1, b'q' * 100) for _ in range(40)])
        self.assertEqual(len(safe), nal_guard.MAX_NALS); self.assertTrue(problems)

    def test_empty_and_unexpected_nals_are_dropped(self):
        safe, problems = nal_guard.sanitize([b'', b'\x65', nal(12, b'\xff' * 10), nal(5, b'k' * 50)])
        self.assertEqual(len(safe), 1); self.assertEqual(len(problems), 3)

def _have_rig():
    try:
        import dave, cryptography  # noqa: F401
    except Exception:
        return False
    return shutil.which('ffmpeg') is not None

CHILD = textwrap.dedent('''
    import os, sys, re, subprocess, logging
    sys.path.insert(0, {tests!r}); sys.path.insert(0, {runtime!r})
    import dave, nal_guard
    from dave_rig import establish, encryptor_for
    logging.disable(logging.CRITICAL)
    guarded = sys.argv[1] == 'guarded'; cut = int(sys.argv[2])
    cmd = ['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=30,noise=alls=12:allf=t','-t','1',
           '-threads','4','-c:v','libx264','-preset','veryfast','-tune','zerolatency','-profile:v','high',
           '-x264-params','aud=1','-b:v','6000k','-f','h264','pipe:1']   # 4 slices per picture, like the bug
    data = subprocess.run(cmd, capture_output=True, check=True).stdout
    nals = [p for p in re.split(rb'\\x00\\x00\\x00?\\x01', data)[1:] if p.rstrip(b'\\x00')]
    nals = [n.rstrip(b'\\x00') for n in nals]
    slices = [n for n in nals if n[0] & 0x1f in (1, 5)]
    a, b = establish(); enc = encryptor_for(b, '200')
    for i in range(1, len(slices) - 1):
        frame = [slices[i], slices[i + 1][:cut]]            # a complete slice plus a half-read tail
        if guarded:
            frame, _ = nal_guard.sanitize(frame)
            if not frame: continue
        enc.encrypt(dave.MediaType.video, 701, b''.join(b'\\x00\\x00\\x00\\x01' + n for n in frame))
    print('survived')
''')

@unittest.skipUnless(_have_rig(), 'needs dave.py, cryptography and ffmpeg')
class RealDaveTests(unittest.TestCase):
    def run_child(self, mode, cut):
        script = CHILD.format(tests=str(HERE), runtime=str(HERE.parent / 'runtime'))
        return subprocess.run([sys.executable, '-c', script, mode, str(cut)], capture_output=True, text=True, timeout=180)

    def test_guard_prevents_the_libdave_abort_for_cut_off_slices(self):
        for cut in (2, 3, 4):
            r = self.run_child('guarded', cut)
            self.assertEqual(r.returncode, 0, f'cut={cut}: {r.stderr[-300:]}')
            self.assertIn('survived', r.stdout)

    def test_without_the_guard_libdave_really_does_abort(self):
        # Documents the bug this guard exists for. If a newer libdave fixes it, this test can be removed.
        crashed = [self.run_child('raw', cut).returncode != 0 for cut in (2, 3, 4)]
        self.assertTrue(any(crashed), 'libdave no longer aborts on cut-off slices; the guard may be unnecessary')

if __name__ == '__main__':
    unittest.main()
