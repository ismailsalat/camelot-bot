"""Child process for test_dave_e2e.py. Real H264VideoPlayer (real FFmpeg + the worker's command tweaks) -> real libdave encryptor, stopped at random moments."""
import sys, os, time, random, logging, threading
from types import SimpleNamespace
from pathlib import Path
HERE=Path(__file__).parent
sys.path.insert(0,str(HERE.parent/'runtime')); sys.path.insert(0,str(HERE))
mode=sys.argv[1]          # old | new
cycles=int(sys.argv[2]); seed=int(sys.argv[3]) if len(sys.argv)>3 else 1
os.environ['STREAM_X264_PRESET']='veryfast'; os.environ['STREAM_FFMPEG_THREADS']='4'
import camelot_worker as w
import dave
from dave_rig import establish, encryptor_for
from streaming.video_player import H264VideoPlayer
logging.basicConfig(level=logging.ERROR)
a,b=establish(); enc=encryptor_for(b,'200',ssrc=701)
stats={'frames':0,'errors':0}
def encrypt_only(self,units):
    annex=b''.join(b'\x00\x00\x00\x01'+n for n in units)
    r=enc.encrypt(dave.MediaType.video,701,annex); stats['frames']+=1
    if r is None: stats['errors']+=1
if mode=='new':
    w._original_send_frame=encrypt_only
    H264VideoPlayer._send_frame=w._guarded_send_frame
else:
    H264VideoPlayer._send_frame=encrypt_only
    # old behaviour: sliced threads, i.e. undo the single-slice setting
    orig=w._headers_ffmpeg_cmd
    def old_cmd(self):
        cmd=orig(self)
        j=cmd.index('-x264-params')+1
        cmd[j]='aud=1'
        return cmd
    H264VideoPlayer._ffmpeg_cmd=old_cmd
random.seed(seed)
standby=w.STANDBY
for i in range(cycles):
    vc=SimpleNamespace(ssrc=54320,_connection=SimpleNamespace(dave_session=None,mode='test'))
    p=H264VideoPlayer(standby,vc,fps=30,live=False,audio=True)
    p.start()
    from live_session import PCMReader
    reader=PCMReader(p.audio_fifo,p)
    def drain():
        while p.is_source_active(): reader.read(3840)
    threading.Thread(target=drain,daemon=True).start()
    time.sleep(random.uniform(float(os.environ.get('LO','0.5')),float(os.environ.get('HI','2.5'))))
    p.stop(); p.join(10)
    print('cycle',i,'frames so far',stats['frames'],flush=True)
print('SURVIVED',mode,stats)
