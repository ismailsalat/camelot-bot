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
        async def stop(*_a):bot.live.player=None
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
    async def test_quality_switch_can_swap_the_stream_url_and_keeps_subtitles(self):
        bot=self.make_bot(duration=1400);bot.mode='streaming'
        bot.job={'duration':1400,'url':'https://cdn.example.com/720/i.m3u8','headers':{'Referer':'https://x/'},'isHLS':True,'subtitlePath':'/tmp/a.ass','quality':'720p'}
        seen=[]
        async def play(job):seen.append(job)
        bot._play=play
        await bot.seek({'position':60,'quality':'1080p','url':'https://cdn.example.com/1080/i.m3u8','headers':{'Referer':'https://x/'},'isHLS':True})
        self.assertEqual(seen[0]['url'],'https://cdn.example.com/1080/i.m3u8')
        self.assertEqual(seen[0]['quality'],'1080p');self.assertEqual(seen[0]['subtitlePath'],'/tmp/a.ass');self.assertEqual(seen[0]['position'],60)
        await bot.seek({'position':90})                      # a plain seek keeps whatever stream is active
        self.assertEqual(seen[1]['url'],'https://cdn.example.com/1080/i.m3u8')
    async def test_countdown_clip_is_a_slate_that_plays_once_and_never_counts_as_an_episode(self):
        self.assertTrue(Path(worker.COUNTDOWN).is_file(),'the pre-rendered 5-4-3-2-1 clip ships with the worker')
        self.assertIn(worker.COUNTDOWN,worker.SLATES);self.assertIn(worker.STANDBY,worker.SLATES)
        bot=self.make_bot();bot.job={'duration':1400,'url':'https://cdn.example.com/a.m3u8'}
        seen=[]
        async def play(job):seen.append(job)
        bot._play=play
        await bot.countdown({'channel':'123456789012345678'})
        self.assertEqual(seen[0]['url'],worker.COUNTDOWN);self.assertEqual(seen[0]['channel'],'123456789012345678')
        self.assertEqual(bot.job['url'],'https://cdn.example.com/a.m3u8','the countdown does not replace the episode that is loading')
        self.assertNotIn(worker.COUNTDOWN,[worker.STANDBY],'only the standby screen loops')
    async def test_countdown_op_is_routed_by_the_control_loop(self):
        bot=self.make_bot();reader=asyncio.StreamReader();bot.input=reader
        reader.feed_data(b'{"op":"countdown","channel":"123456789012345678","requestId":"7"}\n')
        got=[];original=worker.emit;worker.emit=lambda op,**fields:got.append({'event':op,**fields})
        async def countdown(job):got.append(('countdown',job['channel']))
        bot.countdown=countdown
        task=asyncio.create_task(bot.read_controls())
        try:
            await asyncio.sleep(.05)
            self.assertIn(('countdown','123456789012345678'),got);self.assertIn({'event':'ack','requestId':'7','ok':True},got)
        finally:
            task.cancel();await asyncio.gather(task,return_exceptions=True);worker.emit=original
    async def test_end_cleanup_cannot_overlap_next_play(self):
        bot=self.make_bot();entered=asyncio.Event();finish=asyncio.Event();order=[]
        async def stop(*_a):
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

class KickTests(unittest.IsolatedAsyncioTestCase):
    def bot_in(self,voice_client,mode='streaming'):
        bot=worker.CamelotOnline.__new__(worker.CamelotOnline)
        stopped=[]
        async def stop(*_a):stopped.append(1)
        bot.live=SimpleNamespace(player=SimpleNamespace(_frames_emitted=300,_fps=30,_proc=None,is_alive=lambda:True),sender=None,stop=stop)
        bot.offset=12.0;bot.job={'duration':1400};bot.reported=True;bot.mode=mode;bot.play_lock=asyncio.Lock();bot.started=time.monotonic()
        bot.target_channel='222';bot.gone_ticks=0;bot.fail_reason=''
        guild=SimpleNamespace(voice_client=voice_client)
        bot.get_guild=lambda gid:guild
        bot._stopped=stopped
        return bot
    async def test_kicked_account_is_reported_after_three_checks_and_stopped(self):
        events=[];original=worker.emit;worker.emit=lambda op,**f:events.append({'event':op,**f})
        try:
            bot=self.bot_in(None)
            await bot.monitor_once();await bot.monitor_once()
            self.assertEqual(bot.mode,'streaming',msg='a short blip must not trigger a rejoin')
            await bot.monitor_once()
            self.assertEqual(bot.mode,'failed');self.assertEqual(bot.fail_reason,'kicked')
            self.assertEqual(bot._stopped,[1])
            failed=[e for e in events if e['event']=='failed'];self.assertEqual(failed[0]['reason'],'kicked')
            self.assertGreaterEqual(failed[0]['position'],12.0)
        finally:worker.emit=original
    async def test_moved_to_another_channel_counts_as_removed(self):
        events=[];original=worker.emit;worker.emit=lambda op,**f:events.append({'event':op,**f})
        try:
            vc=SimpleNamespace(channel=SimpleNamespace(id=999),is_connected=lambda:True)
            bot=self.bot_in(vc)
            for _ in range(3):await bot.monitor_once()
            self.assertEqual(bot.fail_reason,'kicked')
        finally:worker.emit=original
    async def test_account_in_the_right_channel_is_left_alone(self):
        vc=SimpleNamespace(channel=SimpleNamespace(id=222),is_connected=lambda:True)
        bot=self.bot_in(vc)
        for _ in range(5):await bot.monitor_once()
        self.assertEqual(bot.fail_reason,'');self.assertEqual(bot.gone_ticks,0)
    async def test_deliberate_switching_is_never_mistaken_for_a_kick(self):
        bot=self.bot_in(None,mode='switching')
        for _ in range(5):await bot.monitor_once()
        self.assertEqual(bot.gone_ticks,0);self.assertEqual(bot.fail_reason,'')
if __name__=='__main__':unittest.main()
