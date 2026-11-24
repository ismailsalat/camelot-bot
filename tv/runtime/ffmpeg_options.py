"""HLS compatibility for extensionless media, matching src/ffmpeg.mjs."""
import functools
import subprocess
import re
from pathlib import Path


def hls_input_options(help_text):
    args = ['-protocol_whitelist', 'https,tls,tcp,crypto,httpproxy',
            '-format_whitelist', 'hls,mpegts,mov,aac,mp3,webvtt',
            '-allowed_extensions', 'ALL']
    if 'allowed_segment_extensions' in help_text:
        args += ['-allowed_segment_extensions', 'ALL']
    if 'extension_picky' in help_text:
        args += ['-extension_picky', '0']
    return args


@functools.lru_cache(maxsize=1)
def ffmpeg_hls_options():
    result = subprocess.run(['ffmpeg', '-hide_banner', '-h', 'demuxer=hls'],
                            capture_output=True, text=True, timeout=5, check=True)
    return hls_input_options(result.stdout + result.stderr)


def subtitle_filter(path):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+\.ass', path):
        raise ValueError('Invalid caption cache path')
    resolved = Path(path).resolve()
    if resolved.name != 'captions.ass' or not resolved.parent.name.startswith('camelot-tv-subs-') or not resolved.is_file():
        raise ValueError('Caption file unavailable')
    return f'ass=filename={resolved}'


def apply_source_options(command, headers, is_hls, subtitle_path=None):
    """Put input-only options before the first -i, never the audio FIFO output."""
    args = list(ffmpeg_hls_options()) if is_hls else []
    if headers:
        args += ['-headers', ''.join(f'{k}: {v}\r\n' for k, v in headers.items())]
    command = list(command)
    index = command.index('-i')
    command[index:index] = args
    if subtitle_path:
        overlay = subtitle_filter(subtitle_path)
        # Prepend to scaling/hwupload so libass receives software video frames.
        if '-vf' in command:
            index = command.index('-vf') + 1
            command[index] = overlay + ',' + command[index]
        else:
            index = command.index('-i') + 2
            command[index:index] = ['-vf', overlay]
    return command
