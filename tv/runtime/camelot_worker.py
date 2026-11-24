"""Experimental Discord Go Live worker.
Only receives commands from its local parent process via stdin (not from arbitrary Discord users).
Discord prohibits self-bot user-account automation. Use a disposable test account.
"""
from __future__ import annotations
import asyncio, json, logging, os, re, sys, time
from pathlib import Path
from urllib.parse import urlsplit

import discord
import discord.gateway
import discord.voice_state
from discord.ext import commands
import davey_compat
import video_compat
from live_session import LiveSession
from streaming.video_player import H264VideoPlayer
from ffmpeg_options import apply_source_options, ffmpeg_hls_options

TOKEN = ''
ACTIVE_LINKS = set()
ACTIVE_HEADERS = set()
GUILD_ID = 0

class Redact(logging.Filter):
    def filter(self, record):
        try:
            msg = record.getMessage()
            for secret in [TOKEN, *ACTIVE_LINKS, *ACTIVE_HEADERS]:
                if secret and secret in msg:
                    msg=msg.replace(secret,'[REDACTED]')
                    record.msg=msg;record.args=()
        except Exception:
            pass
        return True

logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(name)s %(message)s')
for handler in logging.getLogger().handlers: handler.addFilter(Redact())
log=logging.getLogger('camelot_online')

def emit(op, **fields):
    # Never include tokens, video URLs or CDN headers in machine-readable logs.
    print('TV_BRIDGE_JSON:'+json.dumps({'event':op,**fields},ensure_ascii=True),flush=True)

def valid_url(s):
    if not isinstance(s,str) or len(s)>3000 or any(ord(x)<33 for x in s): return False
    try:
        p=urlsplit(s)
        h=(p.hostname or '').lower().rstrip('.')
        if p.scheme!='https' or p.username or p.password or p.fragment or p.port not in (None,443): return False
        if not h or '.' not in h or not re.fullmatch('[a-z0-9.-]+',h):return False
        if h in ('localhost','localhost.localdomain') or h.endswith(('.local','.internal','.lan','.onion','.test','.invalid')):return False
        import ipaddress
        try:ipaddress.ip_address(h);return False
        except ValueError:return True
    except (ValueError,TypeError):return False

def clean_headers(raw):
    if not isinstance(raw,dict):return {}
    permitted={'referer':'Referer','user-agent':'User-Agent','origin':'Origin'}
    out={}
    for k,v in raw.items():
        name=permitted.get(str(k).lower())
        if name and isinstance(v,str) and len(v)<600 and not any(ord(c)<32 or ord(c)==127 for c in v):out[name]=v
    return out

# Apply request headers when the provider needs a legitimate Referer/User-Agent.
# Uses the existing pinned FFmpeg implementation; no arbitrary shell execution.
_original_ffmpeg_cmd=H264VideoPlayer._ffmpeg_cmd
_source_headers={}
_source_hls={}
_source_subtitles={}
_source_offsets={}
STANDBY=str((Path(__file__).parent / "assets" / "standby.mp4").resolve())
def _headers_ffmpeg_cmd(self):
    cmd=_original_ffmpeg_cmd(self)
    url=str(getattr(self,'_url',''))
    cmd=apply_source_options(cmd, _source_headers.get(url, {}), _source_hls.get(url, False), _source_subtitles.get(url))
    index=cmd.index('-i')
    offset=_source_offsets.get(url,0)
    if url==STANDBY:cmd[index:index]=['-stream_loop','-1']
    elif offset>0:cmd[index:index]=['-ss',str(offset)]
    if url!=STANDBY:cmd[cmd.index('-i'):cmd.index('-i')]=['-rw_timeout','15000000']
    if offset and _source_subtitles.get(url) and '-vf' in cmd:
        i=cmd.index('-vf')+1
        overlay=cmd[i].split(',',1)
        cmd[i]=f'setpts=PTS+{offset}/TB,'+overlay[0]+f',setpts=PTS-{offset}/TB'+(','+overlay[1] if len(overlay)>1 else '')
    return cmd
H264VideoPlayer._ffmpeg_cmd=_headers_ffmpeg_cmd

discord.voice_state.davey=davey_compat
discord.gateway.davey=davey_compat
davey_compat.patch_reinit(discord.voice_state)
video_compat.patch_video(discord.gateway)

class CamelotOnline(commands.Bot):
    def __init__(self):
        super().__init__(command_prefix='!',help_command=None,self_bot=False)
        self.live=LiveSession(self)
        self.play_lock=asyncio.Lock()
        self.job=None
        self.offset=0.0
        self.mode='connected'
        self.reported=False
        self.started=0.0
        self.monitor_task=None

    async def setup_hook(self):
        self.control_task=asyncio.create_task(self.read_controls())
        self.monitor_task=asyncio.create_task(self.monitor())

    async def on_ready(self):
        guild=self.get_guild(GUILD_ID)
        if guild is None:
            log.error('Configured server not found. Add the streaming account to the selected server.')
            emit('error',message='Streaming account is not in the configured server')
            return
        channels=[{'id':str(c.id),'name':c.name} for c in guild.voice_channels]
        channels.sort(key=lambda x:x['name'].lower())
        log.info('Connected to test server: %s (voice channels: %d)', guild.name,len(channels))
        emit('ready',server=guild.name,channels=channels,streamer=str(self.user),streamerId=str(self.user.id))

    async def on_message(self,message):
        # All remote commands go via the authenticated local parent. No Discord chat commands.
        return

    async def read_controls(self):
        while True:
            line=await asyncio.to_thread(sys.stdin.readline)
            if not line:
                await self.close();return
            if len(line)>12000:
                log.warning('Oversized control request rejected');continue
            try:
                job=json.loads(line)
                op=job.get('op')
                if op=='play':await self.play(job)
                elif op=='stop':await self.stop()
                elif op=='standby':await self.standby(job)
                elif op=='pause':await self.pause()
                elif op=='resume':await self.resume()
                elif op=='seek':await self.seek(job)
                elif op=='status':self.status()
                elif op=='quit':await self.close();return
            except Exception as exc:
                log.exception('Control operation failed: %s',type(exc).__name__)
                self.mode='failed'
                emit('failed',message='Control operation failed; try Play again')

    def position(self):
        p=self.live.player
        frames=getattr(p,'_frames_emitted',0) if p and self.mode in ('starting','streaming') else 0
        return self.offset + frames/max(1,getattr(p,'_fps',30))

    async def play(self,job):
        async with self.play_lock:
            await self._play(job)

    async def _play(self,job):
        url=job.get('url','')
        channel_id=str(job.get('channel',''))
        standby=url==STANDBY
        if (not standby and not valid_url(url)) or not re.fullmatch(r'[0-9]{15,22}',channel_id):
            raise ValueError('Invalid video source or channel')
        guild=self.get_guild(GUILD_ID)
        channel=guild.get_channel(int(channel_id)) if guild else None
        if not isinstance(channel,discord.VoiceChannel):raise ValueError('Voice channel unavailable')
        self.mode='switching'
        await self.live.stop()
        ACTIVE_LINKS.add(url)
        headers=clean_headers(job.get('headers'))
        _source_headers.clear();_source_hls.clear();_source_subtitles.clear();_source_offsets.clear()
        _source_headers[url]=headers
        _source_hls[url]=bool(job.get('isHLS'))
        if _source_hls[url]:await asyncio.to_thread(ffmpeg_hls_options)
        if job.get('subtitlePath'):_source_subtitles[url]=job['subtitlePath']
        ACTIVE_HEADERS.update(headers.values())
        offset=float(job.get('position',0))
        if not 0<=offset<=864000:raise ValueError('Invalid position')
        _source_offsets[url]=offset
        if not standby:
            self.job=dict(job);self.offset=offset
        self.reported=False
        self.started=time.monotonic()
        await self.live.start(guild,channel,url)
        self.mode='standby' if standby else 'starting'
        emit(self.mode,channel=channel_id,title=str(job.get('title','Camelot TV'))[:80],position=self.position())

    async def standby(self,job):
        async with self.play_lock:
            await self._play({'url':STANDBY,'channel':job.get('channel'),'title':'Camelot TV · Loading'})

    async def pause(self):
        async with self.play_lock:
            if not self.job:return
            self.offset=self.position()
            await self._play({'url':STANDBY,'channel':self.job['channel'],'title':'Camelot TV · Paused'})
            self.mode='paused'
            emit('paused',position=self.offset)

    async def resume(self):
        async with self.play_lock:
            if self.job:await self._play({**self.job,'position':self.offset})

    async def seek(self,job):
        async with self.play_lock:
            if not self.job:raise ValueError('No episode selected')
            position=float(job.get('position',0))
            duration=float(self.job.get('duration') or 0)
            if not duration or not 0<=position<duration:raise ValueError('Seek outside episode duration')
            if self.mode=='paused':
                self.offset=position
                emit('paused',position=position)
            else:await self._play({**self.job,'position':position})

    async def stop(self):
        async with self.play_lock:
            self.mode='stopping'
            await self.live.stop()
            guild=self.get_guild(GUILD_ID)
            if guild and guild.voice_client:await guild.voice_client.disconnect(force=True)
            self.job=None;self.offset=0;self.mode='connected'
            _source_headers.clear();_source_hls.clear();_source_subtitles.clear();ACTIVE_HEADERS.clear();ACTIVE_LINKS.clear()
            emit('stopped')

    def status(self):
        emit('status',status=self.mode,position=self.position(),running=self.mode=='streaming')

    async def monitor(self):
        while True:
            await asyncio.sleep(1)
            if self.play_lock.locked():continue
            p=self.live.player
            if self.mode not in ('starting','streaming'):continue
            if p and p._frames_emitted>0 and not self.reported:
                self.mode='streaming';self.reported=True
                emit('playing',position=self.position())
            if p and p.is_alive():
                if self.reported and self.live.sender and not self.live.sender.is_alive():
                    await self.live.stop();self.mode='failed';emit('failed',message='Audio connection interrupted');continue
                self.status()
                if not self.reported and time.monotonic()-self.started>35:
                    await self.live.stop();self.mode='failed';emit('failed',message='Video did not start')
                continue
            pos=self.position()
            duration=float((self.job or {}).get('duration') or 0)
            self.offset=pos
            self.mode='ended' if self.reported and (not duration or pos>=duration-5) else 'failed'
            await self.live.stop()
            emit(self.mode,position=pos)

    async def close(self):
        if self.monitor_task:self.monitor_task.cancel()
        await self.live.stop()
        await super().close()

async def main():
    global TOKEN,GUILD_ID
    first=sys.stdin.readline()
    if not first or len(first)>1000:raise SystemExit('Startup handshake missing')
    try:data=json.loads(first)
    except json.JSONDecodeError:raise SystemExit('Invalid initial handshake')
    TOKEN=data.get('token','')
    gid=str(data.get('guild',''))
    if not isinstance(TOKEN,str) or not 30<=len(TOKEN)<=250 or not re.fullmatch(r'[0-9]{15,22}',gid):
        raise SystemExit('Missing/invalid account credentials or guild ID')
    GUILD_ID=int(gid)
    emit('connecting')
    bot=CamelotOnline()
    try:await bot.start(TOKEN)
    finally:await bot.close()

if __name__=='__main__':
    log.warning('Discord user-account automation violates Discord rules. Test account only.')
    try:asyncio.run(main())
    except KeyboardInterrupt:pass
