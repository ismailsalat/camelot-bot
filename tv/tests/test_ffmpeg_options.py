import sys
import unittest
from unittest.mock import patch
from tempfile import TemporaryDirectory
from pathlib import Path
sys.path.insert(0, 'runtime')
from ffmpeg_options import apply_source_options


class StreamInputTests(unittest.TestCase):
    def test_hls_options_precede_input_and_preserve_audio_and_video_outputs(self):
        original = ['ffmpeg', '-i', 'https://cdn.example.com/m3u8',
                    '-map', '0:v:0', '-f', 'h264', 'pipe:1',
                    '-map', '0:a:0', '-f', 's16le', '/tmp/audio.fifo']
        with patch('ffmpeg_options.ffmpeg_hls_options', return_value=['-extension_picky','0']):
            result = apply_source_options(original, {'Referer':'https://example.com/'}, True)
        self.assertLess(result.index('-extension_picky'), result.index('-i'))
        self.assertLess(result.index('-headers'), result.index('-i'))
        self.assertEqual(result[result.index('-i'):], original[1:])
        self.assertNotIn('-extension_picky', original)

    def test_mp4_does_not_get_hls_options(self):
        command=['ffmpeg','-i','https://example.com/sample.mp4','-f','null','-']
        with patch('ffmpeg_options.ffmpeg_hls_options') as detect:
            self.assertEqual(apply_source_options(command, {}, False), command)
            detect.assert_not_called()

    def test_subtitles_run_before_hardware_upload_and_preserve_both_outputs(self):
        with TemporaryDirectory(prefix='camelot-tv-subs-') as directory:
            caption = Path(directory) / 'captions.ass'
            caption.write_text('[Script Info]\n')
            command = ['ffmpeg', '-i', 'https://example.com/video.mp4',
                       '-vf', 'format=nv12,hwupload,scale_vaapi=w=1280:h=720',
                       '-c:v', 'h264_vaapi', '-f', 'h264', 'pipe:1',
                       '-map', '0:a:0', '-f', 's16le', '/tmp/audio.fifo']
            result = apply_source_options(command, {}, False, str(caption))
            self.assertEqual(result[result.index('-vf')+1], f'ass=filename={caption},format=nv12,hwupload,scale_vaapi=w=1280:h=720')
            self.assertEqual(result[-5:], command[-5:])

    def test_arbitrary_caption_paths_are_rejected(self):
        from ffmpeg_options import subtitle_filter
        with self.assertRaises(ValueError):
            subtitle_filter('/etc/passwd')


if __name__ == '__main__':
    unittest.main()


class X264TuningTests(unittest.TestCase):
    def test_preset_and_lanczos_apply_only_to_libx264(self):
        import importlib.util, os, sys, types
        src = (Path(__file__).parents[1] / 'runtime' / 'camelot_worker.py').read_text()
        start = src.index("X264_PRESETS=")
        end = src.index("_original_ffmpeg_cmd=")
        ns = {'os': os, 're': __import__('re')}
        exec(src[start:end], ns)
        os.environ['STREAM_X264_PRESET'] = 'veryfast'
        try:
            cmd = ['ffmpeg', '-vf', 'subs.ass,scale=1280:720', '-c:v', 'libx264', '-preset', 'ultrafast']
            ns['_tune_x264'](cmd)
            self.assertEqual(cmd[cmd.index('-preset') + 1], 'veryfast')
            self.assertIn('scale=1280:720:flags=lanczos', cmd[2])
            hw = ['ffmpeg', '-vf', 'scale_vaapi=w=1280:h=720', '-c:v', 'h264_vaapi', '-preset', 'ultrafast']
            ns['_tune_x264'](hw)
            self.assertEqual(hw[hw.index('-preset') + 1], 'ultrafast')
            os.environ['STREAM_X264_PRESET'] = 'bogus'
            c2 = ['ffmpeg', '-vf', 'scale=1280:720', '-c:v', 'libx264', '-preset', 'ultrafast']
            ns['_tune_x264'](c2)
            self.assertEqual(c2[c2.index('-preset') + 1], 'ultrafast')
        finally:
            os.environ.pop('STREAM_X264_PRESET', None)
