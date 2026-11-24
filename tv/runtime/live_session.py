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
        self.last = None
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
        conn = self.connection
        self.connection = None
        try:
            await self._stop_media()
        finally:
            if conn:
                try:await asyncio.wait_for(conn.disconnect(), 5)
                except Exception:self.poisoned=True

    async def _stop_media(self):
        """Stop the encoder, audio sender and pipe; the Go Live connection itself stays up."""
        player, sender, reader = self.player, self.sender, self.reader
        self.player = self.sender = self.reader = None
        try:
            self.last = {'video': player and (player._seq, player._ts, player._nonce[0]),
                         'audio': sender and (sender._seq, sender._ts, sender._nonce), 'at': time.monotonic()}
        except AttributeError:
            self.last = {'at': time.monotonic()}
        try:
            if player:
                player.stop()
                # FFmpeg ignores SIGTERM while blocked writing to its pipe, and the player then waits 3 s
                # before SIGKILL on every episode change. Nothing needs a graceful exit here.
                proc = getattr(player, '_proc', None)
                try:
                    if proc and proc.poll() is None:proc.kill()
                except Exception:pass
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
            if sender:
                sender.stop()
                await asyncio.to_thread(sender.join, 2)
                if hasattr(sender,'is_alive') and sender.is_alive():self.poisoned=True
            if reader:reader.close()

    def can_swap(self, channel_id):
        """True when the Go Live connection is healthy and in this channel, so only the video needs replacing."""
        conn = self.connection
        task = getattr(conn, '_poll_task', None) if conn else None
        return bool(conn and not self.poisoned and task is not None and not task.done()
                    and str(getattr(conn, 'channel_id', channel_id)) == str(channel_id))

    async def swap_media(self):
        """Stop only the current video/audio; call attach() next."""
        await self._stop_media()

    async def attach(self, url):
        """Start a new video on the existing Go Live connection (no new stream, no 1.5 s wait, no reconnect).
        RTP sequence numbers, timestamps and nonces continue where the old player stopped, so the receiver
        sees one uninterrupted stream and no nonce is ever reused."""
        conn = self.connection
        if not conn:raise RuntimeError('No Go Live connection to reuse')
        gap = max(0.0, time.monotonic() - (self.last or {}).get('at', time.monotonic()))
        try:
            player = H264VideoPlayer(url=url, voice_client=_GoLiveVCProxy(conn),
                                     fps=_stream_fps(), live=False, audio=True)
            last = (self.last or {}).get('video')
            if last:
                player._seq = last[0]
                player._ts = (last[1] + int(gap * 90000)) & 0xFFFFFFFF
                player._nonce[0] = last[2]
            self.player = player
            player.start()
            deadline = time.monotonic() + 15
            while not os.path.exists(player.audio_fifo):
                if time.monotonic() > deadline or not player.is_alive():
                    raise RuntimeError('Video player failed to create audio pipe')
                await asyncio.sleep(.05)
            self.reader = PCMReader(player.audio_fifo, player)
            sender = GoLiveAudioSender(self.reader, conn, player.is_source_active)
            audio = (self.last or {}).get('audio')
            if audio:
                sender._seq = audio[0]
                sender._ts = (audio[1] + int(gap * 48000)) & 0xFFFFFFFF
                sender._nonce = audio[2]
            self.sender = sender
            sender.start()
        except BaseException:
            raise

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
