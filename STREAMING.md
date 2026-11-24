# Camelot Streaming

This package adds Streaming to the existing Camelot bot. Use the files **inside camelot-bot-main** as the repository root. It has not been deployed or connected to your Discord account from this workspace.

## Railway

1. Apply the package using [UPDATE.md](UPDATE.md), including the updated Dockerfile and the whole `tv` directory. Keep your existing Railway Discord bot variables.
2. Keep one replica. Attach a persistent Volume at `/data`, with `DATABASE_PATH=/data/camelot.sqlite`. The bot database, streaming session and encryption key must survive redeploys. Back up `/data/camelot.sqlite` and `/data/streaming.key` together.
3. Use the included Dockerfile builder and `node dist/index.js` start command. Do not set a public HTTP health check: this is a Discord worker, and its TV API binds only to loopback. No public TV domain is needed.
4. After deploying, an owner or admin opens `/settings` → Streaming → **Turn on Streaming** (the owner can also use Modules), then **Save account** and enters the streaming account token privately, then **Check account**. It is encrypted in SQLite and never filled back into the form or printed in the panel. Discord token input itself is an ordinary private modal, not a password-masked field.
5. Alternatively set `CAMELOT_STREAMER_TOKEN` and `CAMELOT_GUILD_ID` in Railway Variables. Saved settings take precedence. Removing the saved token does not delete Railway Variables. An optional `STREAMING_SECRET_KEY` must be exactly 64 hex characters and stay unchanged. Otherwise the application creates `/data/streaming.key`.
Use **Check account** in Settings → Streaming to verify login and server membership before playing. This check does not start a stream. `/help` lists Streaming even when it is off, and Bot Status checks whether its saved account can be opened.

6. The streaming account must already belong to the server and have access to the voice channel. Camelot needs View Channel, Send Messages, Read Message History and Attach Files in VC chat. The streaming account needs Connect, Speak and Video permissions.
7. Join a VC and use `/stream` or type `!stream` in chat. Select **Find anime**, pick the title, then **Play**. New commands publish automatically at startup.

The image installs Node, Python, FFmpeg, Opus and fonts. Software H.264 is supported without a GPU. Defaults are 720p, 30 fps, 6000k video bitrate, x264 preset `superfast` and a Lanczos scaler. For a sharper picture set these in Railway Variables: `STREAM_RESOLUTION=1920:1080`, `STREAM_VIDEO_BITRATE=8000k`, `STREAM_X264_PRESET=veryfast` (more CPU; if it stutters, step back one). With a 1080p output the 1080p source is preferred.

## Controls

The panel lives in VC chat and follows Camelot's existing component style. It includes anime artwork when the catalogue supplies one, title, episode, language, source, state and elapsed/total duration.

- First row: Previous ep · Next ep · Stop · Play/Pause.
- Second row: Back 30 seconds · Forward 30 seconds · Custom · Episode.
- Third row: Find anime · Sub/Dub · My turn.
- Source dropdown: Auto or a matching source. The selected source is attempted first; verified alternatives are tried if it fails.

Custom accepts `12:30`, `750`, `+90` or `-30`. Seek buttons clamp to the episode's bounds; custom input outside the bounds is rejected. Sources without a reported duration display `--:--` and cannot be seeked. Position comes from emitted video frames, so it is approximate to a second; the panel refreshes every five seconds.

An original animated color-bar slate appears in the panel while idle/loading/paused/offline. A looping color-bar video is also sent during preparation and source switches. A normal Discord connection handshake can still create a brief gap between Go Live streams.

Buttons route through the main interaction handler and have no collector timeout. Session metadata survives a restart; the panel becomes available with a **Play to resume** message. Playback does not silently resume into a VC after a bot restart. `/stream` can recreate missing controls.

The panel reposts after chat activity, no more than once every five seconds. A replacement is sent before deleting the old panel, so a failed send keeps the existing controls. Only the previous bot panel is deleted. Discord outages or revoked permissions can prevent updates; literal permanent last-message placement is not possible.

## One active controller

One controller and one VC are reserved across this bot instance. Other users cannot move the stream or change playback. Admins in the active VC can intervene. **My turn** joins a first-in-first-out queue; pressing it again leaves the queue. Waiters must remain in the VC they chose. Stop, episode completion without auto-next, idle timeout and empty VC timeout release the session. The old worker must disconnect before the next controller receives it.

Default idle timeout is 120 seconds; default empty-VC timeout is 60 seconds. Both are editable from Settings → Streaming. Paused sessions count as idle. A controller who leaves gets the idle grace period, after which the session is released. The streaming account itself is excluded from viewer counts. Auto-next is on by default and can be changed in Settings.

The application will not voluntarily move a busy stream to another VC. Discord administrators can still disconnect or move accounts with Discord's own permissions. Use a single Railway replica; do not run another deployment with the same streaming account.

## Sources

Eleven adapters are registered: HiAnime, AnimeParadise, Anikoto, MegaPlay, AniNeko, AllManga, Gogoanime, Goyabu, AnimePahe, AnimeKai and KickAssAnime. These are candidates, not eleven guaranteed independent working hosts. Anikoto/MegaPlay share infrastructure; Gogoanime/AniNeko can overlap. Goyabu is Portuguese and is not offered as an English dub. KickAssAnime's current adapter is limited to Sub because it cannot select English audio reliably.

Each candidate must match the same title/season, episode and requested language. Playback requires FFmpeg to decode a real frame. Requests have time limits, and a source search/play attempt has a three-minute budget. `CAMELOT_PROVIDERS` can restrict enabled adapters without code changes. No DRM or paywall circumvention is included.

The new HiAnime adapter follows the current ani-cli page format. Three additional adapters use pinned @consumet/extensions 1.8.8. The existing anime-sdk remains pinned at 1.1.0. Direct live-provider verification was blocked by DNS restrictions in the build workspace; verify availability from Railway. Older or blocked sites may still fail.

References: https://github.com/pystardust/ani-cli/blob/master/ani-cli · https://github.com/consumet/consumet.ts · https://github.com/hexxt-git/anime-sdk

## Recovery and known limits

Episode replacement waits for the old FFmpeg process, audio reader and Go Live connection to stop. It no longer uses shared guild slots that an old cleanup task could remove after a replacement started. EOF/failed/paused/playing events are explicit, rather than inferred from warning text. A watchdog retries interrupted playback at the last reported position up to twice, then leaves a usable error panel. The encrypted token is retained when the worker exits.

The existing Go Live transport uses an unofficial Discord user-account library, not Discord's supported bot video API. Its compatibility and Discord's account rules still apply. A source or Discord outage cannot be made impossible by local code.

No Discord account or live Railway deployment was used for validation. Docker itself was unavailable here, so a complete container build remains to be verified on Railway; TypeScript compilation, npm dependency install, Python dependency install/import, local API authentication and real FFmpeg/FIFO start-stop cycles were checked separately.

## Validation

- `npm test`: 309 bot tests, including new session, queue, permissions, token, time input and panel recovery cases.
- `npm run typecheck` and `npm run build`: passed.
- `cd tv && npm test`: 56 TV tests.
- `python3 -m unittest discover -s tests -p 'test_*.py'`: 8 Python utility/lifecycle tests.
- `node tests/server-smoke.mjs`: loopback API authentication, state response, secret exclusion and all 11 registrations.
- `.cloud-venv/bin/python tests/worker_regression.py`: 6 worker tests, including EOF classification, acknowledged controls and episode-cleanup locking.
- `node tests/control_smoke.mjs`: real local HTTP/worker command path, with a test worker replacing Discord.
- `.cloud-venv/bin/python tests/player_smoke.py`: two real FFmpeg + PCM FIFO start/stop cycles, with only the Discord packet transport replaced by a test sink.

After deployment, check Play → Next → Previous → Pause → Play → seek, then Stop and a second user's queued turn. Confirm the saved account still shows Saved after a redeploy.

## v12 fixes

Help, Settings and Bot Status consistently include Streaming. Blank token forms do not clear the saved account. Settings distinguish a saved account from Railway variables, and include a connection check.

Next/Previous clear the old episode timing. Seek uses the current worker position and checks the duration. Controls wait for worker acknowledgments. Stop cancels pending work before freeing the reservation. Stream-end cleanup holds the same lock as episode replacement. A failed FFmpeg exit cannot be mistaken for a completed episode.

The panel retries transient update failures without deleting its working copy. Updates arriving during a Discord edit are applied afterward. Loading disables overlapping playback changes, and unauthorized clicks cannot change the active stream’s state. Public failures use short wording; source diagnostics stay in logs.

## v13 command entry fix

Startup checks Discord’s command list instead of trusting a local fingerprint. A missing `/stream` is repaired globally and upserted into joined servers without deleting unrelated guild commands. Failed startup syncs retry twice. Registration starts before member-cache loading and panel recovery, using the logged-in application ID.

`!stream` opens the same VC panel as `/stream`, with the same account, module, voice-channel, queue and controller rules. It remains available even with a custom prefix or general text commands turned off. The configured prefix also works when text commands are on. Enable Message Content Intent in the Developer Portal so text commands can be read.

The 11 added tests cover actual text routing, module/voice restrictions, busy-session handling, cached-but-missing commands, guild registration, retry reporting and preservation of other servers’ global commands. No live Discord registration was performed in the build workspace.

## v14 fixes

- **Account check always failed.** The TV worker received the account token on stdin, but FFmpeg encoder probes run at import time and inherited that same pipe, swallowing the token line ("Invalid initial handshake"). The worker now keeps a private copy of the pipe and gives child processes /dev/null.
- **Real failure reasons.** A rejected token, a banned/locked account, or an account that is not in the server now produce a specific message in Discord instead of a generic one. TV service output is also written to the bot log (tokens redacted), so Railway logs show what happened.
- **Pasted tokens** are cleaned of surrounding quotes and a `Bot ` prefix before saving.
- **No switch to enable Streaming.** Admins can now press **Turn on / Turn off Streaming** in Settings → Streaming. Modules (owner only) still has it too, listed last.
- **Two `/stream` commands.** /stream was registered both globally and per server. It is now global only, and leftover per-server copies are deleted at startup. If Discord still shows two, restart the Discord app (Ctrl+R) to clear its cache.

## v15 fixes (failed first Play, waiting time)

- **First Play failed and needed a reconnect.** Restarting Go Live right after the previous stream was torn down made Discord never answer, so the start timed out. The worker now waits briefly, retries up to 3 times (re-joining voice on retries), and no longer restarts the standby slate when it is already showing.
- **Waiting time.** Search and episode loading used to wait for the slowest of 11 sources (12–16 s each). Once one source has answered, the rest now get 3 s (`SEARCH_GRACE_MS`, `EPISODE_GRACE_MS`); stragglers keep running and are cached for Play. Each source search is capped at 7 s (`PROVIDER_SEARCH_MS`). Picking a title reuses the sources already found, and switching episodes no longer waits 3 s for FFmpeg to ignore SIGTERM.
- **Clarity.** Measured on Railway: 720p30 held 30.0 fps with no late frames, so the CPU has headroom. Bitrate went from 2500k to 6000k, preset from `ultrafast` to `superfast`, and scaling uses Lanczos.
- **Stops mid-playback.** Start-up and stall watchdogs are more patient (60 s / 90 s), so a slow source is not mistaken for a dead stream.

## v16 fixes (worker crash at Play, faster /stream)

- **Streamer died right after the video was verified.** The log showed `Streamer stopped (exit code unknown)`, which means the Python worker was killed by a signal (out-of-memory or a native crash) and every source then failed with "not connected". Now: (1) if that happens during Play, the bot reconnects the account once and plays again automatically; (2) the TV service logs the signal, the worker's last 12 output lines and the container memory limit / OOM-kill count, so the cause is visible in Railway logs; (3) after a crash it switches to **safe mode** (720p30, 4500k, superfast, 3 threads) for later connections; (4) FFmpeg threads are capped (`STREAM_FFMPEG_THREADS`, default 4) because containers report the host's core count, not their quota.
- **`/stream` answers immediately.** Logging the streaming account in (~7 s) now happens in the background while you pick an anime.
