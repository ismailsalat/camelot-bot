"""Lifecycle regression tests with fake Discord transport; no account used."""
import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path

def module(name,**attrs):
    m=types.ModuleType(name)
    for k,v in attrs.items():setattr(m,k,v)
    sys.modules[name]=m

module('cogs');module('cogs.utils',ensure_voice=None)
module('streaming');module('streaming.golive',GoLiveConnection=None,GoLiveAudioSender=None,_GoLiveVCProxy=None)
module('streaming.video_player',H264VideoPlayer=None,_stream_fps=lambda:30)
spec=importlib.util.spec_from_file_location('live_session',Path(__file__).parents[1]/'runtime/live_session.py')
live=importlib.util.module_from_spec(spec);spec.loader.exec_module(live)

class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_shutdown_drains_player_before_audio_and_connection(self):
        order=[]
        class Player:
            def stop(self):order.append('video stop')
            def join(self,timeout):order.append('video join')
            def is_alive(self):return False
        class Audio:
            def stop(self):order.append('audio stop')
            def join(self,timeout):order.append('audio join')
        class Reader:
            def close(self):order.append('pipe close')
        class Connection:
            async def disconnect(self):order.append('disconnect')
        s=live.LiveSession(None);s.player=Player();s.sender=Audio();s.reader=Reader();s.connection=Connection()
        await s.stop()
        self.assertEqual(order,['video stop','video join','audio stop','audio join','pipe close','disconnect'])
        self.assertIsNone(s.player);await s.stop() # idempotent cleanup
        self.assertEqual(len(order),6)

    async def test_slow_join_does_not_block_gateway_loop(self):
        import time
        ticks=[]
        class Player:
            def stop(self):pass
            def join(self,timeout):time.sleep(.1)
            def is_alive(self):return False
        s=live.LiveSession(None);s.player=Player()
        async def tick():
            await asyncio.sleep(.01);ticks.append('alive')
        await asyncio.gather(s.stop(),tick());self.assertEqual(ticks,['alive'])


class CleanupFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_stuck_video_still_closes_audio_and_poisoned_session_cannot_restart(self):
        order=[]
        class Player:
            _proc=None
            def stop(self):pass
            def join(self,timeout):pass
            def is_alive(self):return True
        class Reader:
            def close(self):order.append('pipe')
        class Connection:
            async def disconnect(self):order.append('connection')
        s=live.LiveSession(None);s.player=Player();s.reader=Reader();s.connection=Connection()
        with self.assertRaises(RuntimeError):await s.stop()
        self.assertEqual(order,['pipe','connection']);self.assertTrue(s.poisoned)
        with self.assertRaisesRegex(RuntimeError,'Restart streaming'):await s.start(None,None,'test')

    async def test_cancelled_stop_finishes_cleanup_before_returning(self):
        import threading
        started=threading.Event();finish=threading.Event();order=[]
        class Player:
            def stop(self):pass
            def join(self,timeout):started.set();finish.wait(2);order.append('joined')
            def is_alive(self):return False
        class Reader:
            def close(self):order.append('closed')
        s=live.LiveSession(None);s.player=Player();s.reader=Reader()
        task=asyncio.create_task(s.stop())
        await asyncio.to_thread(started.wait,1);task.cancel();finish.set()
        with self.assertRaises(asyncio.CancelledError):await task
        self.assertEqual(order,['joined','closed']);self.assertIsNone(s.cleanup)

class RestartRetryTests(unittest.IsolatedAsyncioTestCase):
    """Regression: a Go Live restart that Discord never answered used to fail the whole Play."""
    async def test_start_retries_after_a_timed_out_connect_and_then_succeeds(self):
        attempts=[]
        async def ensure_voice(channel,vc):return object()
        class Conn:
            def __init__(self,bot,guild,channel,vc):self.channel_id=channel
            async def connect(self,timeout=0):
                attempts.append(timeout)
                if len(attempts)<3:raise asyncio.TimeoutError()
            async def disconnect(self):pass
        class Player:
            audio_fifo=__file__
            def __init__(self,**kw):pass
            def start(self):pass
            def is_alive(self):return True
            def is_source_active(self):return True
        class Sender:
            def __init__(self,*a):pass
            def start(self):pass
        live.ensure_voice=ensure_voice;live.GoLiveConnection=Conn;live.H264VideoPlayer=Player;live.GoLiveAudioSender=Sender;live._GoLiveVCProxy=lambda c:c;live._stream_fps=lambda:24
        live.PCMReader=lambda path,player:types.SimpleNamespace(close=lambda:None)
        real_sleep=asyncio.sleep
        async def fast(delay,*a):await real_sleep(0)
        live.asyncio=types.SimpleNamespace(sleep=fast,wait_for=asyncio.wait_for,to_thread=asyncio.to_thread,create_task=asyncio.create_task,shield=asyncio.shield,CancelledError=asyncio.CancelledError)
        try:
            guild=types.SimpleNamespace(id=1,voice_client=None)
            s=live.LiveSession(None)
            await s.start(guild,types.SimpleNamespace(id=2),'https://x')
            self.assertEqual(len(attempts),3)
            self.assertTrue(s.running_on(2))
            self.assertFalse(s.running_on(3))
        finally:
            live.asyncio=asyncio

    async def test_gives_up_with_the_last_error_after_three_attempts(self):
        async def ensure_voice(channel,vc):return object()
        class Conn:
            def __init__(self,*a):pass
            async def connect(self,timeout=0):raise asyncio.TimeoutError()
            async def disconnect(self):pass
        live.ensure_voice=ensure_voice;live.GoLiveConnection=Conn
        real_sleep=asyncio.sleep
        async def fast(delay,*a):await real_sleep(0)
        live.asyncio=types.SimpleNamespace(sleep=fast,wait_for=asyncio.wait_for,to_thread=asyncio.to_thread,create_task=asyncio.create_task,shield=asyncio.shield,CancelledError=asyncio.CancelledError)
        try:
            with self.assertRaises(asyncio.TimeoutError):
                await live.LiveSession(None).start(types.SimpleNamespace(id=1,voice_client=None),types.SimpleNamespace(id=2),'https://x')
        finally:
            live.asyncio=asyncio

class SwapTests(unittest.IsolatedAsyncioTestCase):
    async def test_swap_keeps_connection_and_continues_rtp_counters(self):
        events=[]
        class Task:
            def done(self):return False
        class Conn:
            channel_id=7;_poll_task=Task()
            async def disconnect(self):events.append('disconnect')
        class Old:
            _proc=None;_seq=500;_ts=9000;_nonce=[0x80000010]
            def stop(self):events.append('old stop')
            def join(self,t):pass
            def is_alive(self):return False
        class OldAudio:
            _seq=40;_ts=1920;_nonce=12
            def stop(self):pass
            def join(self,t):pass
        class Reader:
            def close(self):events.append('pipe close')
        made={}
        class New:
            audio_fifo='/dev/null'
            def __init__(self,**kw):self._seq=0;self._ts=0;self._nonce=[0x80000000];made['video']=self
            def start(self):events.append('new start')
            def is_alive(self):return True
            def is_source_active(self):return True
        class NewAudio:
            def __init__(self,*a):self._seq=0;self._ts=0;self._nonce=0;made['audio']=self
            def start(self):events.append('audio start')
        class FakeReader:
            def __init__(self,*a):pass
        live.H264VideoPlayer=New;live.GoLiveAudioSender=NewAudio;live.PCMReader=FakeReader;live._GoLiveVCProxy=lambda c:c
        s=live.LiveSession(None);s.connection=Conn();s.player=Old();s.sender=OldAudio();s.reader=Reader()
        self.assertTrue(s.can_swap('7'));self.assertFalse(s.can_swap('8'))
        await s.swap_media();self.assertNotIn('disconnect',events)
        await s.attach('https://example.test/video')
        self.assertNotIn('disconnect',events);self.assertIs(s.connection.__class__,Conn)
        self.assertEqual(made['video']._seq,500);self.assertGreaterEqual(made['video']._ts,9000)
        self.assertEqual(made['video']._nonce[0],0x80000010)
        self.assertEqual((made['audio']._seq,made['audio']._nonce),(40,12));self.assertGreaterEqual(made['audio']._ts,1920)

    async def test_poisoned_or_dead_connection_is_not_reused(self):
        class Task:
            def done(self):return True
        class Conn:
            channel_id=7;_poll_task=Task()
        s=live.LiveSession(None);s.connection=Conn()
        self.assertFalse(s.can_swap('7'))

if __name__=='__main__':unittest.main()
