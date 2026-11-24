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

if __name__=='__main__':unittest.main()

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
