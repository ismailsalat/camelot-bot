"""One explicitly owned stream. Cleanup finishes before the next stream starts."""
import asyncio
import os
import select
import time
from cogs.utils import ensure_voice
from streaming.golive import GoLiveConnection, GoLiveAudioSender, _GoLiveVCProxy
from streaming.video_player import H264VideoPlayer, _stream_fps

class PCMReader:
    def __init__(self, path, player):
        self.fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        self.player = player
        self.closed = False
    def read(self, size):
        data = bytearray()
        while not self.closed and self.player.is_source_active() and len(data) < size:
            if not select.select([self.fd], [], [], .1)[0]:
                continue
            try:
                part = os.read(self.fd, size - len(data))
            except BlockingIOError:
                continue
            if part:
                data.extend(part)
            else:
                time.sleep(.02)
        return bytes(data)
    def close(self):
        if not self.closed:
            self.closed = True
            os.close(self.fd)

class LiveSession:
    def __init__(self, bot):
        self.bot = bot
        self.player = self.sender = self.connection = self.reader = None
        self.cleanup = None
        self.poisoned = False
    async def stop(self):
        if not self.cleanup:self.cleanup=asyncio.create_task(self._stop())
        task=self.cleanup
        try:await asyncio.shield(task)
        except asyncio.CancelledError:
            # Finish owned cleanup even if the caller is shutting down.
            await task
            raise
        finally:
            if task.done() and self.cleanup is task:self.cleanup=None

    async def _stop(self):
        player, sender, conn, reader = self.player, self.sender, self.connection, self.reader
        self.player = self.sender = self.connection = self.reader = None
        try:
            if player:
                player.stop()
                await asyncio.to_thread(player.join, 8)
                if player.is_alive():
                    proc = player._proc
                    if proc and proc.poll() is None:proc.kill()
                    await asyncio.to_thread(player.join, 3)
                if player.is_alive():raise RuntimeError('Old video player did not stop; restart worker before playing again')
        except BaseException:
            self.poisoned = True
            raise
        finally:
            try:
                if sender:
                    sender.stop()
                    await asyncio.to_thread(sender.join, 2)
                    if hasattr(sender,'is_alive') and sender.is_alive():self.poisoned=True
                if reader:reader.close()
            finally:
                if conn:
                    try:await asyncio.wait_for(conn.disconnect(), 5)
                    except Exception:self.poisoned=True
    def running_on(self, channel_id):
        """True when a stream is already live in this voice channel."""
        conn = self.connection
        return bool(self.player and self.player.is_alive() and conn
                    and str(getattr(conn, 'channel_id', channel_id)) == str(channel_id))

    async def start(self, guild, channel, url):
        had_previous = bool(self.player or self.connection)
        await self.stop()
        if self.poisoned:raise RuntimeError('Restart streaming account before playing again')
        # Discord needs a moment to finish deleting the previous Go Live stream. Creating the
        # next one immediately made it never answer, so the start timed out after 25 seconds.
        if had_previous:await asyncio.sleep(1.5)
        last = None
        for attempt in range(3):
            try:
                await self._start_once(guild, channel, url, rejoin=attempt > 0)
                return
            except asyncio.CancelledError:raise
            except Exception as exc:
                last = exc
                if self.poisoned or attempt == 2:break
                await asyncio.sleep(2 + attempt * 2)
        raise last

    async def _start_once(self, guild, channel, url, rejoin=False):
        if rejoin and guild.voice_client:
            # A stale voice session is the usual reason a Go Live stream never answers.
            try:await asyncio.wait_for(guild.voice_client.disconnect(force=True), 5)
            except Exception:pass
        vc = await asyncio.wait_for(ensure_voice(channel, guild.voice_client),15)
        conn = GoLiveConnection(self.bot, guild.id, channel.id, vc)
        self.connection = conn
        try:
            await conn.connect(timeout=10)
            player = H264VideoPlayer(url=url, voice_client=_GoLiveVCProxy(conn),
                                     fps=_stream_fps(), live=False, audio=True)
            self.player = player
            player.start()
            deadline = time.monotonic() + 15
            while not os.path.exists(player.audio_fifo):
                if time.monotonic() > deadline or not player.is_alive():
                    raise RuntimeError('Video player failed to create audio pipe')
                await asyncio.sleep(.05)
            self.reader = PCMReader(player.audio_fifo, player)
            self.sender = GoLiveAudioSender(self.reader, conn, player.is_source_active)
            self.sender.start()
        except BaseException:
            await self.stop()
            raise
