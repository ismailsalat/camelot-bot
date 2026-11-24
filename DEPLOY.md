# Deploying Camelot

Camelot is a single always-on process with a SQLite file next to it. It needs no
public web server or external database. Streaming runs a private local worker in the same service. See [STREAMING.md](STREAMING.md) for account setup.

---

## 1 · Push to GitHub

Make the repo on github.com first — **private**, no README, no .gitignore (this
project has its own). Then, in the project folder:

```
cd C:\Users\caano\Documents\camelot-bot
git init
git add .
git status
```

`git status` is the one step worth not skipping. You should see your source and
docs, and you should **not** see `.env`, `data/`, `node_modules/` or `dist/`.
If `.env` appears, stop and fix `.gitignore` before committing.

```
git commit -m "Camelot"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/camelot-bot.git
git push -u origin main
```

`.gitignore` already excludes `.env`, `node_modules/`, `dist/`, `data/` and
every `*.sqlite` file.

**If a token ever lands in a commit**, reset it in the Developer Portal
immediately. Deleting the line in a later commit does not help — the old commit
still holds it, and anyone with the repo can read it.

### Pushing changes later

```
git add .
git commit -m "what changed"
git push
```

Railway redeploys on its own when you push to `main`.

---

## 2 · Deploy on Railway

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → pick
   your repo.
2. Railway reads `railway.json` and builds with the included `Dockerfile`. No
   build or start command to type.
3. **Variables** tab → add:

   | Variable | Value |
   |---|---|
   | `DISCORD_TOKEN` | your bot token |
   | `DISCORD_CLIENT_ID` | your application ID |
   | `DATABASE_PATH` | `/data/camelot.sqlite` |
   | `COMMAND_PREFIX` | `!` *(optional)* — prefix for text commands like `!allies` |
   | `LOG_LEVEL` | `info` *(optional)* |

4. **⚠️ Add a Volume.** Service → **Settings** → **Volumes** → **New Volume**,
   mount path **`/data`**.

   Without a volume, Railway gives the container a fresh filesystem on every
   deploy. Your server settings, saved streaming account, encryption key and clip history would be
   wiped each time you push. This is the one step people skip.

5. Deploy. The logs should show:

   ```
   SQLite ready at /data/camelot.sqlite
   Logged in as Camelot#1234 in 1 server(s).
   Scheduler started (tick 15000ms)
   ```

### Registering the slash command

**Camelot does this itself.** On boot it reads the registered commands from Discord and repairs missing entries. It registers `/stream` in each joined server as well. A matching local cache never suppresses this check. Failed startup syncs retry after one minute and then five minutes.

Look for `Camelot Streaming v13: /stream and !stream handlers loaded.` and `Verified 6 slash commands against Discord` in the logs. If the first line is missing, this update is not the running deployment. The `!stream` text entry does not depend on slash registration.

If you would rather do it by hand, from your own machine pointing at the same
app:

```bash
npm install
cp .env.example .env     # token + client id
npm run register
```

Leave `DEV_GUILD_ID` empty in production so commands register globally. Set it
to a server ID while developing — guild commands appear instantly, global ones
can take up to an hour the first time.

If a publish fails (a bad token, Discord down), Camelot logs it and keeps
running on the commands already registered, then retries at startup and on the next boot.

---

## Backing up

Keep a consistent backup of the SQLite database and `/data/streaming.key` together. If `STREAMING_SECRET_KEY` is set instead, retain that secret securely. Stop the service or use SQLite's backup API when copying the database; copying an open WAL database alone can miss recent changes.

Do not rotate the encryption key without re-saving the streaming account. Without the original key, the encrypted token cannot be recovered.

---

## Other hosts

Anything that runs a container and gives you a persistent volume works the same
way — Fly.io, Render, a VPS, a Raspberry Pi:

```bash
docker build -t camelot .
docker run -d --name camelot --restart unless-stopped \
  -e DISCORD_TOKEN=... \
  -e DISCORD_CLIENT_ID=... \
  -e DATABASE_PATH=/data/camelot.sqlite \
  -v camelot-data:/data \
  camelot
```

Bare Node on a VPS, under systemd or pm2:

```bash
npm ci && npm run build && npm start
```

---

## Updating

Push to `main`; Railway rebuilds and restarts. On boot Camelot re-queues every
open session, re-schedules the weekly job, and re-pins the panel if it's
missing. Jobs are keyed on `(kind, ref)`, so a restart mid-session can't produce
a duplicate DM or a double weekly announcement.

---

## Troubleshooting a deploy

| Log line | Fix |
|---|---|
| `Missing required environment variable DISCORD_TOKEN` | Add it in **Variables** |
| `Login failed` / `401` | Token is wrong or was reset — paste a fresh one |
| `SQLITE_CANTOPEN` | The volume isn't mounted at `/data`, or `DATABASE_PATH` points elsewhere |
| Settings reset after each deploy | No volume — see step 4 |
| `Used disallowed intents` | Turn **Message Content** on in the Developer Portal |
| Builds fail on `better-sqlite3` | You switched off the Dockerfile; it needs `python3`, `make`, `g++` (see `nixpacks.toml`) |
