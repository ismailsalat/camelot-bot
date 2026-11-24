"""Run with .cloud-venv/bin/python tests/worker_regression.py; no Discord login."""
import asyncio
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).parents[1]/'runtime'))
import camelot_worker as worker

class WorkerTests(unittest.IsolatedAsyncioTestCase):
    def make_bot(self, rc=0, duration=None):
        bot=worker.CamelotOnline.__new__(worker.CamelotOnline)
        player=SimpleNamespace(_frames_emitted=300,_fps=30,_proc=SimpleNamespace(poll=lambda:rc),is_alive=lambda:False)
        async def stop():bot.live.player=None
        bot.live=SimpleNamespace(player=player,sender=None,stop=stop)
        bot.offset=0;bot.job={'duration':duration};bot.reported=True;bot.mode='streaming';bot.play_lock=asyncio.Lock();bot.started=time.monotonic()
        return bot
    async def test_failed_ffmpeg_with_unknown_duration_does_not_autonext(self):
        bot=self.make_bot(rc=1)
        await bot.monitor_once();self.assertEqual(bot.mode,'failed')
    async def test_clean_eof_with_unknown_duration_finishes(self):
        bot=self.make_bot(rc=0)
        await bot.monitor_once();self.assertEqual(bot.mode,'ended')
    async def test_premature_clean_eof_is_a_failure(self):
        bot=self.make_bot(rc=0,duration=120)
        await bot.monitor_once();self.assertEqual(bot.mode,'failed')
    async def test_end_cleanup_cannot_overlap_next_play(self):
        bot=self.make_bot();entered=asyncio.Event();finish=asyncio.Event();order=[]
        async def stop():
            entered.set();await finish.wait();order.append('old stopped');bot.live.player=None
        async def play(job):order.append('next started')
        bot.live.stop=stop;bot._play=play
        task=asyncio.create_task(bot.monitor())
        await asyncio.wait_for(entered.wait(),3)
        replacement=asyncio.create_task(bot.play({}))
        await asyncio.sleep(.02);self.assertEqual(order,[])
        finish.set();await replacement;task.cancel()
        await asyncio.gather(task,return_exceptions=True)
        self.assertEqual(order,['old stopped','next started'])
    async def test_pause_without_episode_is_an_error(self):
        bot=self.make_bot();bot.job=None
        with self.assertRaises(ValueError):await bot.pause()
    async def test_control_ack_is_emitted_after_operation(self):
        bot=self.make_bot();reader=asyncio.StreamReader();bot.input=reader
        reader.feed_data(b'{"op":"pause","requestId":"1"}\n')
        start=asyncio.Event();finish=asyncio.Event();events=[]
        async def pause():start.set();await finish.wait()
        bot.pause=pause;original=worker.emit;worker.emit=lambda op,**fields:events.append({'event':op,**fields})
        task=asyncio.create_task(bot.read_controls())
        try:
            await start.wait();self.assertEqual(events,[])
            finish.set();await asyncio.sleep(.01)
            self.assertEqual(events,[{'event':'ack','requestId':'1','ok':True}])
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True);worker.emit=original
if __name__=='__main__':unittest.main()
