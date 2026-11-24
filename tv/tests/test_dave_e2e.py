"""Real player + real FFmpeg + real libdave, stopped at random moments (what happens when an episode starts
after the standby slate). Skipped unless dave.py, cryptography, discord.py-self and ffmpeg are installed."""
import os, shutil, subprocess, sys, unittest
from pathlib import Path
HERE = Path(__file__).parent

def _ready():
    try:
        import dave, cryptography, discord  # noqa: F401
    except Exception:
        return False
    return shutil.which('ffmpeg') is not None

@unittest.skipUnless(_ready(), 'needs dave.py, cryptography, discord.py-self and ffmpeg')
class StopStartTests(unittest.TestCase):
    def run_child(self, mode, cycles, seed):
        env = dict(os.environ, LO='0.6', HI='3', PYTHONPATH=str(HERE.parent / 'runtime'))
        return subprocess.run([sys.executable, str(HERE / 'dave_e2e_child.py'), mode, str(cycles), str(seed)],
                              capture_output=True, text=True, timeout=240, env=env)

    def test_current_settings_survive_repeated_stops(self):
        for seed in (1, 2):
            r = self.run_child('new', 8, seed)
            self.assertEqual(r.returncode, 0, r.stderr[-400:])
            self.assertIn('SURVIVED', r.stdout)

    def test_old_sliced_settings_really_crashed(self):
        r = self.run_child('old', 8, 1)
        self.assertNotEqual(r.returncode, 0, 'the old sliced encode no longer crashes libdave; this test can go')

if __name__ == '__main__':
    unittest.main()
