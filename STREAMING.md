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

## v17 (newest panel only, rejoin after a kick, anime queue, auto-start)

- **Only the newest panel works.** `/stream` (or `!stream`) now always posts a fresh panel as the last message in the voice channel's chat and deletes the previous one. It also sweeps any other Camelot panel left in that chat. Buttons on an older panel are rejected, and that old panel is removed when someone presses it. When a session moves to another voice channel, its old panel is deleted. Anyone chatting still pushes the panel back to the bottom after a few seconds, as before.
- **Kicked or disconnected? It comes back.** If someone removes Camelot from the voice channel (kick, move, disconnect), it rejoins and resumes the same episode at the same time, retrying every 10 seconds, until someone presses **Stop** (which ends the session) or the voice channel is empty for the configured time. The panel shows "Camelot was removed from the voice channel. Coming back…".
- **Anime queue.** The panel has a **Queue** button. Anyone in the voice channel can add anime from it (search, then pick). The controller or an admin can remove one, clear the queue, or **Play next now**. When an anime's last episode ends, the next queued anime loads and starts on its own; one that no longer loads is skipped. The panel shows **Up next** (up to 3 titles). Stop clears the queue. **My turn** is unchanged; it is the line of *people* waiting for the controls.
- **Starts by itself.** After you pick an anime (and when the queue moves on), Camelot counts **5, 4, 3, 2, 1** in the voice channel's chat and then plays episode 1. No need to press Episode or Play. Pressing Stop, Play, Next/Previous, Episode or picking another anime during the countdown cancels or replaces it.
- **Early searches no longer wait.** The background account log-in no longer holds the panel's busy lock, so searching right after `/stream` can't hit "One moment, the last change is still finishing."

## v18 (the "encoder won't start" bug, and debug output)

- **Root cause of the cutting out / failing to play.** Railway logs showed `Invalid chars ''' at the end of expression '6000k''` and `Error setting option maxrate to value 6000k'`. A stray apostrophe on the `STREAM_VIDEO_BITRATE` variable made FFmpeg refuse to open the encoder, for the standby slate and for every episode (the fallback encoder `libopenh264` does not exist in this container). Fixed in three layers: the TV service cleans every `STREAM_*` value (quotes, spaces, `x` in resolutions) and drops invalid ones with a warning; the Python worker does the same at start-up; and any malformed `-b:v`/`-maxrate`/`-bufsize` in a finished FFmpeg command is repaired before it runs. In Railway, set the value as plain `6000k` with no quotes.
- **Debug output.**
  - The log now says `Stream settings: 1280:720 at 30 fps, 6000k, x264 superfast, 4 threads` every time the account connects, and `Setting fixed: …` for any variable that had to be corrected.
  - When playback is interrupted, the log shows the last FFmpeg message (`Playback interrupted (…). Last FFmpeg message: …`) and the worker's last 6 lines. Log lines from the TV service are kept up to 1500 characters, so FFmpeg commands are no longer cut off.
  - While someone is controlling, a `[stream] phase=… worker=… episode=… position=… source=… retries=… queue=… rejoin=… safeMode=…` line is logged every 30 seconds.
  - A failure line records the worker status, last error, safe mode, episode and source. The panel also shows a short `Reason:` line.
  - **Settings → Streaming → Debug info** (admins) shows the bot state, TV service state, video settings, fixed settings and the last 10 TV log lines, with no tokens or links.

## v19 (the streamer crash `Fatal Python error: Aborted`)

- **What the log showed.** Right as an episode started: ten `dave Frame is too small to contain the encrypted frame` lines, `dave encryption failed: 4`, `Fatal Python error: Aborted`, and `Streamer stopped (signal SIGABRT)`. Every source then reported "not connected".
- **Cause, reproduced.** Discord's native encryption library (libdave) parses each H.264 slice header itself, and corrupts memory (then aborts the whole process) for a slice NAL under 5 bytes that is not the first slice of its picture, and for frames of about 24+ NAL units. Two things fed it such data: (1) when the standby slate is stopped, the player flushes a half-read NAL, and (2) `-threads 4` with `-tune zerolatency` made x264 split every picture into 4 slices, which the player then sent as 4 separate "frames" (4x the frame rate, so lag and cutting) and which makes tiny non-first slices common. Reproduced with a real two-member DAVE group and the real player: the old settings aborted in 3 of 3 runs, the new ones survived 30 stop/start cycles. See `tv/tests/dave_rig.py`, `test_nal_guard.py`, `test_dave_e2e.py`.
- **Fix.** (1) x264 now makes one slice per picture (`slices=1:sliced-threads=0`), so the player sends exactly one frame per picture. (2) `tv/runtime/nal_guard.py` sits in front of the encryption: nothing is encrypted while playback is stopping, slices under 6 bytes and frames over 16 NAL units are skipped, and an encryption exception skips that frame instead of killing the video thread. Skips are logged as `Video guard skipped unsafe data…`.
- **After a crash.** The retry now reloads the title first (the restarted TV service has forgotten its search), which fixes `Choose an anime and episode from search results first` on the automatic reconnect.
- **Railway settings.** Delete `STREAM_VIDEO_BITRATE` (the default is 6000k) and `STREAM_X264_PRESET` (default superfast; veryfast uses more CPU for little visible gain). Bad values are cleaned or ignored since v18.

## v20 — faster start / episode switch, steadier video

- **Picking an anime and switching episodes are much faster.** `startEpisode` no longer asks the TV service for the episode list again (that re-inspected every source, ~4 s); it plays the id it already has, and only reloads the list if the service restarted. While loading an anime, episode lookup and the "standby" Go Live window now happen at the same time.
- **One Go Live restart instead of two when switching.** `/api/play` only shows the standby slate when nothing is live. If an episode is already streaming, it keeps playing while the next one is verified, then swaps once (saves ~8 s).
- **Stutter:** x264 presets slower than `superfast` are ignored (a warning is logged). `veryfast` fell behind real time on Railway's shared CPUs (late frames, ffmpeg read stalls). Set `STREAM_ALLOW_SLOW_PRESET=1` to force one. Best fix: delete `STREAM_X264_PRESET` and `STREAM_VIDEO_BITRATE` in Railway.
- **"Loading" after being away:** this is the Discord client re-subscribing to the stream when a tab/window is hidden. The stream sends a keyframe every second so it recovers quickly; Camelot cannot prevent the client's own pause.

## v21 — no more reconnecting, smoother picture

- **Seek, resume, pause and episode changes keep the Go Live connection.** Previously every one of them deleted the stream and built a new one (about 8-13 s of "reconnecting"). Now only the video (FFmpeg + audio pipe) is replaced on the existing connection (`LiveSession.swap_media/attach`). RTP sequence numbers, timestamps and nonces carry on from the old player so Discord sees one continuous stream and no nonce is reused. If the connection is not healthy, or the swap fails, it falls back to the old full restart automatically (the log says "Could not reuse the Go Live connection").
- **Smoother video:** keyframe packets are paced (`STREAM_PACKET_PACE` defaults to 0.6) instead of sent as one burst; video bitrate is capped at 4000k for 720p (6000k for 1080p) and the rate-control buffer is halved, so keyframes stay small. Opt out with `STREAM_ALLOW_HIGH_BITRATE=1`. Default x264 preset is now `superfast` (`ultrafast` was the pinned default and the least efficient).
- Delete `STREAM_X264_PRESET` and `STREAM_VIDEO_BITRATE` from Railway; the defaults are now right.
- Tests: `test_live_session.py` (SwapTests), `test_ffmpeg_options.py` (BitrateCapTests, SlowPresetTests).

## v22 — clearer panel, seasons, quality button

- **Panel:** `Season 2 · Episode 5 of 12 · SUB · 720p`, then a progress bar with the time (`━━━━●─────  10:31 / 21:32`), then the state and source. The ±30 s buttons are gone; **Jump to time** (12:30, 750, +90, -30) stays. Successful presses no longer leave a private "controls updated" message.
- **Dropdowns:** Season (when the search found other seasons of the same anime) and Episode (long shows page 23 at a time with "Earlier / Later episodes" entries). The Source dropdown only appears after a playback failure.
- **Seasons** come from the titles in the same search (`seasons.ts`): grouped by title, ordered by stated number / year, with movies and specials marked. No extra network requests, so playback is not disturbed.
- **Quality:** 720p30 is the default. When the source really has 1080p (checked with ffprobe), an **Use 1080p** button appears; pressing it swaps the video on the live connection at the same position (no reconnect). The choice resets to 720p for a new anime and falls back to 720p if an episode has no 1080p. 1080p needs more CPU; if it stutters on your Railway plan press **Use 720p**.
- **Smoothness:** packet pacing 0.7, 720p bitrate cap 3500k (1080p 6000k), rate-control buffer 40% of the bitrate.

## v23 — measured stutter cause, diagnostics, provider health, HxH fix

### What was confirmed (measured here) and what was not

| Question | Result |
| --- | --- |
| Is the ffmpeg reader (`read(65536)`) causing bursts? | **No.** Reads are short (avg ~61 KB, 97% "short") but the pipe never runs dry; replacing the reader changed nothing measurable. |
| Does bigger pipe / cheaper scaler fix it? | **No.** `STREAM_PIPE_KB` is now off by default; the scaler flag made no difference. |
| What does cause the freezes? | **More FFmpeg threads than the container's CPU quota.** FFmpeg burns the whole 100 ms quota in a burst, then the kernel freezes it until the next period. |
| Does "four threads" mean four CPUs? | **No.** Railway gives a CPU *quota*; `nproc` shows the host. |

Real `H264VideoPlayer` + the worker's real FFmpeg command, 1080p source → 720p24, 3500k, `superfast`, 25 s, under a Linux CFS quota (`tests/pacing_bench.py`, `/tmp/bench/quota.sh`). "Frozen" = non-overlapping time beyond 1.5 frame intervals:

| CPU quota | threads | picture frozen | gaps > 100 ms | kernel throttled |
| --- | --- | --- | --- | --- |
| 1.0 core | 4 (old default) | 0.07 % | 0 | 19 periods / 1.0 s |
| 1.0 core | 1 | 0.00 % | 0 | 0 |
| 0.5 core | 4 (old default) | **14.8 %** (2.8 s) | 17 | 181 periods / 17.0 s |
| 0.5 core | 1 | 1.6 % (0.3 s) | 0 | 158 periods / 5.7 s |

This is *this sandbox*, not your Railway plan. It shows the mechanism and that the fix goes the right way; the size of the effect on Railway depends on your plan's quota. The worker now picks threads from the detected quota (`auto`, max 4) and prints which quota it saw. Set `STREAM_FFMPEG_THREADS` only to override.

The old log line `late total` was cumulative since playback start, so it kept growing after a single burst and looked like constant lateness. It is no longer used for judging smoothness; the new summaries use non-overlapping frozen time.

**Not measured:** your real Railway quota, cold/warm start on Railway, a 10-minute run on Railway, receiver-side playback (nothing in this code can see what Discord clients display — "sent" always means handed to the network).

### Recommended Railway variables

* Delete `STREAM_X264_PRESET` and `STREAM_VIDEO_BITRATE` (the worker already caps 6000k→3500k and holds the preset at `superfast`; the "Stream settings" log line printed your *requested* values, which looked misleading).
* Delete `STREAM_FFMPEG_THREADS` to use the quota-based default, or set it to the number of vCPUs your plan really gives.
* If the picture still freezes: `STREAM_MAX_HEIGHT=540`, or `STREAM_FPS=20`.

### Diagnostics

* **Correlation id (`cid`)** is created by the bot per play, sent to the TV service, and forwarded to the worker. Every record carries `cid`, `gen`, UTC time, and a monotonic offset of its own process. Durations are only computed inside one process; cross-process numbers are composed from those.
* **Timeline events**: bot — `interaction_received/acked`, `play_requested`, `panel_loading_painted`, `play_acked`, `phase_*`; TV — `play_request`, `resolve_start`, provider events (`provider_resolve_start/done`, `validate_start/done`, `provider_failed` with class), `worker_play_sent`, `play_ack`, `stop_request`, `worker_process_exit`; worker — `play_received`, `encoder` (effective settings), `go_live_ready`, `first_video_sent`, `first_audio_sent`, `media_stopped`, `go_live_closed`, `stats`.
* **Summaries** (`[stats]` lines, every 10 s; every 1 s for 5 minutes after *Settings → Streaming → Detailed stats*): video fps target vs sent, frozen time/stalls/longest, gaps over 25/50/100/250/1000 ms past one frame, skipped frames by reason, FFmpeg read wait, short reads, queued video, RTP timestamp regressions; audio packets, PCM waits/short reads/underruns; CPU quota, container CPU, throttled periods, memory/OOM. Anything not observable (dropped/duplicated frames, encoder speed, queued audio) is `null`, never guessed.
* **Failures explain themselves**: `reason`, `initiated_by`, `exit_code`, `signal`, `intentional`, last state, cleanup — e.g. `Streamer process ended: reason=killed_by_SIGKILL initiated_by=worker … intentional=false`. Worker `failed` events carry `ffmpeg_exit_N`, `ffmpeg_ended_early`, `audio_sender_stopped`, `video_start_timeout`, `kicked`.
* **Bot "loading" vs worker "streaming"**: every phase change logs `phase a -> b worker=…`; a poll that finds the worker streaming while the panel says loading is logged. After each Play the bot now polls every second (max 25 times) instead of waiting for the 5 s tick.
* **Log severity** is preserved (`[error]`→ERROR, `[warning]`→WARN); the worker's own timestamp is stripped from relayed lines.
* **Admin export**: *Settings → Streaming → Export diagnostics* attaches one JSON file (bot timeline + TV timeline + provider health + build info + event-loop delay + container throttling). It contains no tokens, URLs, headers or ffmpeg arguments.
* Local file `…/camelot-tv/timeline.jsonl` (override `CAMELOT_TIMELINE_FILE`) is size-capped at ~1.5 MB with one rotation.

### Providers

* **Hunter × Hunter**: the catalogue spells it `×` and the sources write `x` and add `(2011)`; `sameAnime` rejected all of them. Fixed (`normTitle`, year-aware matching: 2011 never matches 1999). `hxh`, `jjk`, `aot`, `mha`, … now expand to full names. The season dropdown no longer shows 1999/2011 as Season 1/2.
* **Concurrent resolution**: up to 3 providers at once, 9 s per-provider limit, health-ordered; a provider that is still stuck after another one won is still recorded.
* **Health registry** (`tv/src/health.mjs`): per-provider successes/failures, classified (`dns`, `timeout`, `http_error`, `rate_limit`, `parser`, `wrong_title`, `unavailable_episode`, `expired_url`, `manifest`, `segment`, `decode`, `missing_audio`, `cancelled`), cooldown (3 provider-level failures in a row → 2 min, doubling to 15 min). A wrong title or unaired episode never triggers a cooldown. Search also uses it, so a dead host (e.g. `ENOTFOUND`) stops costing a timeout on every search. Nothing is ever removed: if everything is cooling down, everything is tried.
* **Reference repos** (licenses read from their GitHub pages today): `Anihub-Api` — **no license shown, so no code may be copied**; useful only as a list of site names (it mentions Reanime, AnimeGG, AniZone, AniWaves, Anibd, Kickassanime, AnimeDunya, AnimeOnsen; DASH for AnimeOnsen; embeds for AniWaves). `anime-extensions` — Apache-2.0 (Kotlin extensions). `anime-sdk` — MIT (already used). `ani-cli` — GPL-3.0 (do not copy into this project).
* **No new adapters were added.** None of the eight candidates could be reached from the build sandbox, and the spec says to expand only after testing. Run the self-test on Railway: `railway ssh -- node tv/scripts/provider-selftest.mjs` (or paste the command in the service shell). It prints a table and JSON with time, title/episode/language, resolve time, media format, whether FFmpeg decoded a real video frame, and the failure class. Send me that output and I will add only what passes.

### Tests added
`tv/tests/test_diag.py`, `tv/tests/health.test.mjs`, `src/test/stream-v23.test.ts`; `tests/pacing_bench.py --diag` runs the instrumented path.

### v23.1 — from the 00:13–00:20 PT Railway log (it was the old build: TV v0.12.0)

* **Title matching** now also accepts a bare year (`Hunter x Hunter 2011`), a `(TV)` label and a trailing `Dub`/`Sub`, and still rejects `1999`, movies, OVAs and spin-offs.
* **Dead host `anikai.to`** (AnimeKai): the library swallowed the DNS error and returned "no results", so the registry never saw a failure. Extra providers now do a cached DNS check first (`src/hostcheck.mjs`); a dead domain becomes a `dns` failure, cools down, and stops logging the same error every search.
* **Source check no longer competes with the live stream**: the one-frame FFmpeg check runs with one thread and `nice -n 10`. In the log, every Next/switch (08:15:45, 08:18:09–16) shows the playing stream dropping to 20–21 fps while the check ran.
* **`hianime` hung for 12.7 s** (08:17:57 → 08:18:09) before animeparadise was tried; the per-provider limit is now 9 s and providers resolve in parallel.
* A source with **no audio track** now logs a warning and a `missing_audio` timeline event.
* In that log the `phase=loading worker=streaming` lines (08:14:49, 08:15:49, 08:17:24, 08:18:19) are the bot's 5 s poll lagging behind the worker; v23's one-second follow-up poll closes that gap.
* **Read-block** (`ffmpeg read-block 1.0–1.7 s / 10 s`) can come from CPU throttling *or* from a slow source download; this log cannot tell them apart. The v23 `[stats]` lines print throttled periods next to FFmpeg read wait, so the next log will.

## v24 — which anime is this? (TV service v0.14.0)

**What was wrong.** Provider searches carry no year or episode count, so "Hunter x Hunter" from a source could be the 1999 series (62 eps) or the 2011 one (148 eps). The old code matched by name, merged every hit into one list and, on Play, re-searched and tried *all* of them — so the 2011 series could play the 1999 one, and switching Sub↔Dub (which replays through the same queue) could jump versions.

**How it works now** (`tv/src/identity.mjs`, `tv/src/resolve.mjs`):

1. **One entity per real anime**, taken from the catalogue (AniList, Jikan fallback): id, year, format (TV/Movie/OVA/Special/ONA), status, episode total.
2. **Provider hits attach to an entity only with evidence**, in this order: *id* (MegaPlay's media id **is** the AniList id) → *name + year* → *name* (nothing else in the results shares it) → *ambiguous* (remakes share the title). Hits that match nothing become their own entity; "Hunter x Hunter Movie: Phantom Rouge" is recognised as the catalogue's movie.
3. **Ambiguous listings are decided by episode count** against each version's catalogue total (≥ 75 % fit and clearly better than the sibling). A listing with 62 episodes is the 1999 series and is *rejected* for 2011 (and vice versa). If the count fits neither it is refused ("cannot tell the versions apart"), never guessed.
4. **Only verified listings feed the episode list and playback.** `/api/play` queues only verified sources that list the requested language for that episode number. If none does, it fails with `No verified source lists DUB for episode 5 of Hunter x Hunter (2011) (available: SUB)` and never falls back to another version. The bot checks the same thing before toggling Sub/Dub and changes nothing if the language is not listed.
5. **Search is organised**: one row per anime, TV series first, then movies, then OVAs/specials; the year is added when two rows share a title ("Hunter x Hunter (2011)" / "(1999)"); each row says `TV · 2011 · 148 eps · 3 sources`. The season dropdown never treats two same-named TV rows as seasons, and movies/OVAs are "Special".

**Debug output**
* Logs: `Anime search "…": N catalogue titles, M source listings -> K entries`, then one line per top row (`Hunter x Hunter (2011) [TV 2011 148 eps]: megaplay(id), anikoto(ambiguous)`), `Source match: …`, and a **`Match report for "…"`** block with one `ACCEPT` / `REJECT` / `PENDING` line per provider listing and the reason (e.g. `REJECT anikoto "Hunter x Hunter" [ambiguous] 62 eps: 62 episodes fits "Hunter x Hunter (1999)" (62) better than 148`).
* Timeline events `match_report`, `language_unavailable`, `subtitles`, `subtitles_failed`; `/api/diagnostics` has a bounded `matching` section; the bot's *Export diagnostics* includes it, and *Debug info* shows the latest match/subtitle lines.

**Subtitles.** Each play now logs `Subtitles: burning English captions from <provider> (N track(s) offered)`, or — when a source has no English track — the exact list of tracks it offered, and the panel shows `SUB · EN subtitles` or `SUB · no subtitles`. English-track detection accepts labels like `English (CC)`, `English - Subs`, `[English]` and tracks whose kind is `subtitles` (not only `captions`). A real FFmpeg test confirms captions change the picture. Dub never burns subtitles (unchanged).

**Not verified (no network from the build sandbox):** real provider answers. The listing counts above come from fixtures that mimic what your Railway log showed. Degraded mode: if both AniList and Jikan are down, there is no catalogue, so same-title remakes cannot be told apart by year and show up as separate rows only when a source writes the year in the title.

## v25 — freezes, episode jump, skipping (TV service v0.15.0)

**What the 20:35–20:40 UTC log showed.** Episode 1 (megaplay) was fine: 24 fps, ffmpeg ~0.4 core. Episode 207 on anikoto froze at 20:39:48 (`0.9/24 fps, frozen 96 %, ffmpeg 0.02 cores`, video position 27 s → 29 s over 30 s). ffmpeg at 0.02 cores means it was **waiting for data** — the source stopped delivering. It was not CPU (quota 8 cores, ~0.5 used) and not memory (Railway graph: ~0.6 vCPU, ~460 MB). Nothing switched source for over a minute because the old check only asked "did the position go up?", and the position crept up.

**Fixes**
* **Freeze detection** (`src/streaming/stall.ts`): every poll compares how far the video advanced with real time; under 35 % over a 12 s window = frozen. The bot then replays the same episode, language and position from **another source** (`avoid` is sent to `/api/play`; the frozen provider is skipped and counted against its health). Up to 3 attempts, then a clear error. Log: `[stream] video froze: advanced 1.0s in 13s on anikoto … switching source`.
* **Lighter video stream** (`tv/src/variants.mjs`): by default FFmpeg opens the *largest* quality of an HLS master playlist (checked with a local test: it picked the 1080p variant) even though 720p is sent to Discord. The 720p variant is now chosen when the playlist has muxed audio and the variant really lists segments; 1080p mode and "Use 1080p" switch back to the top stream. Log: `Video stream: using the 720p variant (2.8 Mbit/s) of 1080/720/360p`. `STREAM_NO_VARIANT=1` turns it off.
* **Go to episode** button: type `206`, `e206`, `+5`, `-3`, `first` or `last`. Wrong input says what exists (`Episode 500 doesn't exist. The last episode is 291.`; gaps in the sources are explained).
* **Skip buttons**: ⏪ 10 s, ⏩ 30 s, ⏭ Skip intro (85 s). Near the end: `Only 0:20 left in this episode. Press Next for the next one.`

## v26 — restored sessions, no more "One moment…", on-screen countdown (TV service v0.16.0)

**What the 13:30 PT log and your report showed.** After a redeploy the TV service forgets every anime it had loaded. `/stream` restored DBZ from the bot's saved session, Play asked the TV service for an episode it no longer knew, the old fallback searched again but matched on a provider id that the new search rows do not carry (`That title is unavailable right now`), and every click you made meanwhile bounced off the busy lock with "One moment, the last change is still finishing."

**Fixes**
* **Play after a restart works.** The TV service rebuilds a forgotten anime itself (`rehydrate()` in `tv/server.mjs`) from the title and verified entity the bot now sends with every episode request, so the same anime comes back (a 1999 / 2011 mix-up is still impossible). The bot then keeps whatever ids the rebuilt anime has. Opening `/stream` also logs the streaming account in and puts up the standby screen for a restored anime, so Play starts the countdown at once.
* **No more "One moment…" messages.** Buttons on the panel are acknowledged instantly with a silent update (no "thinking…" message appears and disappears). A click that arrives while a change is still running waits up to 1.5 s for it; after that it is ignored silently. Real problems ("That was the last episode") still appear, privately, and never overwrite the panel. Stop keeps its own answer.
* **⏪ 10 s and ⏩ 30 s are gone.** Every seek restarts the video pipeline, so they were slower than just waiting. **⏭ Skip intro (85 s)** and **Jump to time** stay for the jumps that are worth it.
* **Countdown on the screen.** After you pick an anime, the stream shows a pre-rendered 5-4-3-2-1 (`tv/runtime/assets/countdown.mp4`, with beeps) while the source is being checked in the background; the episode starts when it reaches zero. The panel shows a live Discord countdown (`Starting in 4 seconds`, ticking by itself, no repeated edits). The old 5-4-3-2-1 chat messages are gone. The private message after picking is now `🎬 Dragon Ball Z is ready · 291 episodes · SUB & DUB`, the countdown note, and how to cancel.
* **Faster start.** Checking the video (frame check, duration probe, quality variant) now runs in parallel instead of one after the other (about 3 s saved per start). Search logging was cut down. While playing, the panel is only repainted when something visible changes.

**Not measured / honest limits.** The countdown clip, and how exactly it lines up with the episode start, has only been tested with a fake worker; the first real run decides whether the swap needs a small timing tweak. A rebuilt anime has not been tested against the live providers. Some stutter is the source's own delivery and the 720p variant helps with it but cannot remove it.
