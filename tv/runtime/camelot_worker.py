"""Experimental Discord Go Live worker.
Only receives commands from its local parent process via stdin (not from arbitrary Discord users).
Discord prohibits self-bot user-account automation. Use a disposable test account.
"""
from __future__ import annotations
import asyncio, faulthandler, json, logging, os, re, sys, time
from pathlib import Path
from urllib.parse import urlsplit

# The control channel is stdin, and the parent writes the account token to it the
# moment this process starts. Importing the video player below runs FFmpeg encoder
# probes, and any child that inherits fd 0 reads from that same pipe: FFmpeg swallowed
# the token line, the handshake then failed, and the account "could not connect" no
# matter which token was used. Keep a private copy of the pipe for ourselves and
# point fd 0 at /dev/null for every child process.
faulthandler.enable()  # a native crash prints its Python stack to stderr instead of vanishing
CONTROL_FD = os.dup(0)
_null_fd = os.open(os.devnull, os.O_RDONLY)
os.dup2(_null_fd, 0)
os.close(_null_fd)

import env_clean
import nal_guard
env_clean.report(env_clean.clean_stream_env())
# Spread each keyframe's packets over most of a frame interval instead of sending them as one burst
# (bursts overran Discord's relay and froze the picture a few seconds into playback).
os.environ.setdefault('STREAM_PACKET_PACE','0.7')
# 720p30 is the default; 1080p is chosen per episode from the panel (see QUALITY below).
os.environ.setdefault('STREAM_QUALITY','720p')
os.environ.setdefault('STREAM_FPS','30')

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
X264_PRESETS={'ultrafast','superfast','veryfast','faster','fast','medium'}
SLOW_PRESETS={'veryfast','faster','fast','medium'}
_warned_preset=[]
QUALITY={'p':'720p'}  # set by each play request
_logged_once=set()
def _log_once(key,fmt,*args):
    if key in _logged_once:return
    _logged_once.add(key);logging.getLogger('camelot_online').info(fmt,*args)
def _tune_x264(cmd):
    """Software-encoder quality knobs that the pinned player does not expose."""
    if '-c:v' not in cmd or cmd[cmd.index('-c:v')+1]!='libx264':return
    # Containers report the host's core count (often dozens) while their CPU/memory quota is a few
    # vCPUs. Unbounded x264/decoder threads waste memory and hitch under the quota, so cap them.
    raw=os.environ.get('STREAM_FFMPEG_THREADS','').strip()
    threads=raw if raw.isdigit() and 1<=int(raw)<=16 else '4'
    if '-threads' not in cmd:
        cmd[cmd.index('-c:v'):cmd.index('-c:v')]=['-threads',threads]
        cmd[cmd.index('-i'):cmd.index('-i')]=['-threads',threads]
    preset=os.environ.get('STREAM_X264_PRESET','').strip().lower()
    # Presets slower than superfast fell behind real time on the shared vCPUs (late frames, ffmpeg read
    # stalls) and showed up as stutter. Keep them out unless STREAM_ALLOW_SLOW_PRESET=1 is set on purpose.
    if preset in SLOW_PRESETS and os.environ.get('STREAM_ALLOW_SLOW_PRESET','').strip()!='1':
        if not _warned_preset:
            _warned_preset.append(preset)
            logging.getLogger('camelot_online').warning('STREAM_X264_PRESET=%s is too slow for this host; using superfast (set STREAM_ALLOW_SLOW_PRESET=1 to force it)',preset)
        preset='superfast'
    if not preset:preset='superfast'  # ultrafast (the pinned default) is the least efficient; superfast is just as light here
    if preset in X264_PRESETS and '-preset' in cmd:cmd[cmd.index('-preset')+1]=preset
    # -tune zerolatency turns on sliced threads: with -threads 4 every picture became 4 slices, and the player
    # sends each slice as its own frame (4x the frame rate) while tiny non-first slices can crash libdave.
    # One slice per picture with frame threading keeps the timing exact and the data safe.
    if '-x264-params' in cmd:
        j=cmd.index('-x264-params')+1
        parts=[p for p in cmd[j].split(':') if p and p.split('=')[0] not in ('slices','sliced-threads')]
        cmd[j]=':'.join(parts+['slices=1','sliced-threads=0'])
    if '-vf' in cmd:
        i=cmd.index('-vf')+1
        wanted='1920:1080' if QUALITY['p']=='1080p' else '1280:720'
        cmd[i]=re.sub(r'(?<![\w_])scale=\d+:\d+(?![:\d])',f'scale={wanted}',cmd[i],count=1)
        # Lanczos keeps text and line art crisp when scaling a 1080p source down.
        cmd[i]=re.sub(r'(?<![\w_])scale=(\d+:\d+)(?![:\d])',r'scale=\1:flags=lanczos',cmd[i],count=1)

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
    _tune_x264(cmd)
    repaired=env_clean.safe_bitrate_args(cmd)
    if '-c:v' in cmd and cmd[cmd.index('-c:v')+1]=='libx264':
        for note in env_clean.cap_bitrate_args(cmd):_log_once('rate:'+note,'Smoother video settings: %s',note)
    if repaired:logging.getLogger('camelot_online').warning('Repaired invalid FFmpeg bitrate settings: %s',', '.join(repaired))
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

_original_send_frame=H264VideoPlayer._send_frame
_guard_stats={'dropped':0,'last_log':0.0,'reasons':{}}
def _guarded_send_frame(self,nal_units):
    # When playback is stopped the player flushes whatever half-read data is left; never encrypt that.
    if self._end.is_set():return
    safe,problems=nal_guard.sanitize(nal_units)
    if problems:
        _guard_stats['dropped']+=1
        for reason in problems:_guard_stats['reasons'][reason.split(' (')[0]]=_guard_stats['reasons'].get(reason.split(' (')[0],0)+1
        now=time.monotonic()
        if now-_guard_stats['last_log']>=10:
            _guard_stats['last_log']=now
            logging.getLogger('camelot_online').warning('Video guard skipped unsafe data in %d frame(s) so far: %s',_guard_stats['dropped'],', '.join(f'{k} x{v}' for k,v in _guard_stats['reasons'].items()))
    if not safe:return
    try:_original_send_frame(self,safe)
    except Exception as exc:
        logging.getLogger('camelot_online').warning('Video frame could not be encrypted and was skipped: %s',str(exc)[:160])
H264VideoPlayer._send_frame=_guarded_send_frame

discord.voice_state.davey=davey_compat
discord.gateway.davey=davey_compat
davey_compat.patch_reinit(discord.voice_state)
video_compat.patch_video(discord.gateway)

class CamelotOnline(commands.Bot):
    # Defaults at class level so partially built instances (tests) behave.
    target_channel=None
    gone_ticks=0
    fail_reason=''
    def __init__(self, reader=None):
        super().__init__(command_prefix='!',help_command=None,self_bot=False)
        self.input=reader
        self._tv_closing=False
        self.control_task=None
        self.live=LiveSession(self)
        self.play_lock=asyncio.Lock()
        self.job=None
        self.offset=0.0
        self.mode='connected'
        self.reported=False
        self.started=0.0
        self.monitor_task=None
        self.target_channel=None
        self.gone_ticks=0
        self.fail_reason=''

    async def setup_hook(self):
        self.control_task=asyncio.create_task(self.read_controls())
        self.monitor_task=asyncio.create_task(self.monitor())

    async def on_ready(self):
        guild=self.get_guild(GUILD_ID)
        if guild is None:
            log.error('Configured server not found. Add the streaming account to the selected server.')
            emit('error',message='The streaming account is not a member of this server. Join it with that account first.')
            await self.close()
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
            line=(await self.input.readline()).decode("utf-8")
            if not line:
                await self.close();return
            if len(line)>12000:
                log.warning('Oversized control request rejected');continue
            job={}
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
                elif op=='quit':
                    await self.close()
                    emit('ack',requestId=job.get('requestId'),ok=True)
                    return
                else:raise ValueError('Unknown playback control')
                emit('ack',requestId=job.get('requestId'),ok=True)
            except Exception as exc:
                log.exception('Control operation failed: %s',type(exc).__name__)
                self.mode='failed'
                emit('failed',message='Control operation failed; try Play again')
                emit('ack',requestId=job.get('requestId'),ok=False,message='Could not change playback. Press Play to reconnect.')

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
        QUALITY['p']='720p' if standby else ('1080p' if job.get('quality')=='1080p' else '720p')
        self.target_channel=channel_id;self.gone_ticks=0;self.fail_reason=''
        # Keep the Go Live connection when it is healthy and only replace the video. Starting a new
        # stream takes ~8-13 s and made every episode change, seek and resume look like a reconnect.
        vc=guild.voice_client
        reuse=bool(vc and vc.is_connected() and getattr(getattr(vc,'channel',None),'id',None)==channel.id and self.live.can_swap(channel_id))
        if reuse:
            try:await self.live.swap_media()
            except Exception:reuse=False
        if not reuse:await self.live.stop()
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
        if reuse:
            try:await self.live.attach(url)
            except Exception as exc:
                logging.getLogger('camelot_online').warning('Could not reuse the Go Live connection (%s); reconnecting',str(exc)[:120])
                await self.live.stop()
                await self.live.start(guild,channel,url)
        else:await self.live.start(guild,channel,url)
        self.mode='standby' if standby else 'starting'
        emit(self.mode,channel=channel_id,title=str(job.get('title','Camelot TV'))[:80],position=self.position())

    async def standby(self,job):
        async with self.play_lock:
            # Already showing the standby slate in this channel: restarting Go Live here only
            # risks a failed restart, so leave the running stream alone.
            if self.mode=='standby' and self.live.running_on(str(job.get('channel',''))):return
            await self._play({'url':STANDBY,'channel':job.get('channel'),'title':'Camelot TV · Loading'})

    async def pause(self):
        async with self.play_lock:
            if not self.job:raise ValueError('No active episode')
            self.offset=self.position()
            await self._play({'url':STANDBY,'channel':self.job['channel'],'title':'Camelot TV · Paused'})
            self.mode='paused'
            emit('paused',position=self.offset)

    async def resume(self):
        async with self.play_lock:
            if not self.job:raise ValueError('No active episode')
            await self._play({**self.job,'position':self.offset})

    async def seek(self,job):
        async with self.play_lock:
            if not self.job:raise ValueError('No episode selected')
            position=float(job.get('position',0))
            if job.get('quality') in ('720p','1080p'):self.job['quality']=job['quality']
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
            self.job=None;self.offset=0;self.mode='connected';self.target_channel=None;self.gone_ticks=0
            _source_headers.clear();_source_hls.clear();_source_subtitles.clear();ACTIVE_HEADERS.clear();ACTIVE_LINKS.clear()
            emit('stopped')

    def status(self):
        emit('status',status=self.mode,position=self.position(),running=self.mode=='streaming')

    async def monitor(self):
        while True:
            await asyncio.sleep(1)
            async with self.play_lock:
                await self.monitor_once()

    async def voice_lost(self):
        """True once the account has been out of its voice channel for 3 checks in a row (kicked, moved or
        disconnected). A short debounce avoids reacting to Discord's own brief voice reconnects."""
        if not self.target_channel or self.mode not in ('standby','starting','streaming','paused'):
            self.gone_ticks=0;return False
        guild=self.get_guild(GUILD_ID)
        vc=guild.voice_client if guild else None
        here=getattr(getattr(vc,'channel',None),'id',None)
        gone=vc is None or not vc.is_connected() or str(here)!=str(self.target_channel)
        self.gone_ticks=self.gone_ticks+1 if gone else 0
        return self.gone_ticks>=3

    async def monitor_once(self):
        # Caller holds play_lock throughout cleanup. A new episode cannot overlap it.
        if await self.voice_lost():
            # Resume point for the parent, which rejoins and carries on until the controller presses Stop.
            self.offset=self.position();pos=self.offset
            await self.live.stop();self.mode='failed';self.fail_reason='kicked';self.gone_ticks=0
            log.warning('Removed from the voice channel; asking the parent to rejoin.')
            emit('failed',reason='kicked',position=pos);return
        p=self.live.player
        if self.mode not in ('starting','streaming'):return
        if p and p._frames_emitted>0 and not self.reported:
            self.mode='streaming';self.reported=True
            emit('playing',position=self.position())
        if p and p.is_alive():
            if self.reported and self.live.sender and not self.live.sender.is_alive():
                await self.live.stop();self.mode='failed';emit('failed',message='Audio connection interrupted');return
            self.status()
            if not self.reported and time.monotonic()-self.started>60:
                await self.live.stop();self.mode='failed';emit('failed',message='Video did not start')
            return
        pos=self.position()
        duration=float((self.job or {}).get('duration') or 0)
        proc=getattr(p,'_proc',None)
        clean_exit=proc is not None and proc.poll()==0
        self.offset=pos
        self.mode='ended' if self.reported and clean_exit and (not duration or pos>=duration-5) else 'failed'
        await self.live.stop()
        emit(self.mode,position=pos)

    async def close(self):
        if self._tv_closing:return
        self._tv_closing=True
        current=asyncio.current_task()
        tasks=[t for t in (self.monitor_task,self.control_task) if t and t is not current]
        for task in tasks:task.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        try:
            async with self.play_lock:await self.live.stop()
        finally:await super().close()

async def main():
    global TOKEN,GUILD_ID
    reader=asyncio.StreamReader(limit=16384)
    protocol=asyncio.StreamReaderProtocol(reader)
    await asyncio.get_running_loop().connect_read_pipe(lambda:protocol,os.fdopen(CONTROL_FD,'rb',buffering=0))
    first=await reader.readline()
    if not first or len(first)>1000:raise SystemExit('Startup handshake missing')
    try:data=json.loads(first)
    except json.JSONDecodeError:raise SystemExit('Invalid initial handshake')
    TOKEN=data.get('token','')
    gid=str(data.get('guild',''))
    if not isinstance(TOKEN,str) or not 30<=len(TOKEN)<=250 or not re.fullmatch(r'[0-9]{15,22}',gid):
        raise SystemExit('Missing/invalid account credentials or guild ID')
    GUILD_ID=int(gid)
    emit('connecting')
    bot=CamelotOnline(reader)
    try:await bot.start(TOKEN)
    except discord.LoginFailure:
        log.error('Discord rejected the streaming account token.')
        emit('error',message='Discord rejected that token. Use the streaming account\'s user token (not a bot token) and copy it again.')
    except discord.HTTPException as exc:
        log.error('Discord login failed: HTTP %s',getattr(exc,'status','?'))
        emit('error',message=f'Discord refused the login (HTTP {getattr(exc,"status","?")}). The account may be locked or need verification.')
    except Exception as exc:
        log.error('Discord login failed: %s',type(exc).__name__)
        emit('error',message=f'Could not log in to Discord ({type(exc).__name__}).')
    finally:await bot.close()

if __name__=='__main__':
    log.warning('Discord user-account automation violates Discord rules. Test account only.')
    try:asyncio.run(main())
    except KeyboardInterrupt:pass
