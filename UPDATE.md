# Install the Streaming update

Use Node 22. These commands prepare the repository for Railway; the Go Live worker runs in the included Linux container.

1. Extract this ZIP somewhere separate, such as Downloads.
2. Copy **only `patch.mjs`** from its `camelot-bot-main` folder into `C:\Users\caano\Documents\camelot-bot`.
3. Stop any locally running copy of Camelot. In PowerShell, run:

```powershell
cd C:\Users\caano\Documents\camelot-bot
cmd /c "node patch.mjs && npm ci && npm test && npm run build"
```

The chain stops at the first failed command. `node patch.mjs --check` previews the file counts without changing anything.

The installer contains the complete source update. It backs up replaced files and moves obsolete `src` files into a dated `.camelot-backup-*` folder so old code cannot break the build. `.env`, `data`, `.git`, and installed dependencies are preserved. Keep the backup until the updated bot is working. Any local code edits remain in that backup.

4. After all checks pass, review and push:

```powershell
git status --short
git add -A
git commit -m "Fix stream registration and text fallback"
if ($LASTEXITCODE -eq 0) { git push }
```

5. On Railway, use the root Dockerfile, one replica, a persistent volume at `/data`, and `DATABASE_PATH=/data/camelot.sqlite`. Keep the existing bot token and application ID. Do not use a public health-check URL for this Discord worker.
6. In Discord: `/settings` → Modules → **Turn on Streaming**. Then `/settings` → Streaming → **Save account** → **Check account**.
7. Join a voice channel, type `!stream` in chat (or use `/stream`), choose **Find anime**, select a title and press **Play**.

The streaming account must already be in the server. An empty token input is normal after saving; the Settings card shows the stored-account status. After deployment, test Next, Previous, Pause, Play, seeking and a queued user's turn in your server. Live Discord and Railway playback have not been verified from this build workspace.

If `/stream` is missing, use `!stream`. Check Railway logs for `Camelot Streaming v13: /stream and !stream handlers loaded.` to confirm this version is deployed. If `!stream` gets no reply, confirm Message Content Intent is enabled in the Discord Developer Portal, and that Camelot can read and send messages in that channel. The bot publishes commands on startup; it also supports `npm run register:prod` after building when your local `.env` contains the correct bot credentials.
