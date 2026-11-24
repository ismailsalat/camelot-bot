"""Exercise real FFmpeg/FIFO teardown twice, replacing only Discord packet transport."""
import asyncio
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).parents[1]/'runtime'))
from live_session import PCMReader,LiveSession
from streaming.video_player import H264VideoPlayer

async def main():
    for attempt in range(2):
        connection=SimpleNamespace(dave_session=None,mode='test')
        vc=SimpleNamespace(ssrc=54320,_connection=connection)
        player=H264VideoPlayer(str(Path(__file__).parents[1]/'runtime/assets/standby.mp4'),vc,fps=15,live=False,audio=True)
        player._send_frame=lambda units:None
        player.start()
        reader=PCMReader(player.audio_fifo,player)
        count=[0]
        def audio():
            while player.is_source_active():count[0]+=len(reader.read(3840))
        thread=threading.Thread(target=audio,daemon=True);thread.start()
        for n in range(100):
            if player._frames_emitted>=10:break
            await asyncio.sleep(.05)
        assert player._frames_emitted>=10,'No video frames encoded'
        assert count[0]>0,'No PCM audio decoded'
        session=LiveSession(None);session.player=player;session.reader=reader
        await session.stop();thread.join(2)
        assert not thread.is_alive(),'Audio reader did not stop'
        assert not player.is_alive(),'Video player did not stop'
        assert player._proc.poll() is not None,'FFmpeg was not reaped'
        print('PASS: real FFmpeg + audio FIFO start/stop',attempt+1)
asyncio.run(main())
