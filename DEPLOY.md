# Deploying Camelot

Camelot is a single always-on process with a SQLite file next to it. It needs no
web server, no port, and no external database.

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
   | `LOG_LEVEL` | `info` *(optional)* |

4. **⚠️ Add a Volume.** Service → **Settings** → **Volumes** → **New Volume**,
   mount path **`/data`**.

   Without a volume, Railway gives the container a fresh filesystem on every
   deploy. Your server settings, scheduled sessions and clip history would be
   wiped each time you push. This is the one step people skip.

5. Deploy. The logs should show:

   ```
   SQLite ready at /data/camelot.sqlite
   Logged in as Camelot#1234 in 1 server(s).
   Scheduler started (tick 15000ms)
   ```

### Registering the slash command

Do this once (and again whenever the command definition changes). Easiest from
your own machine, pointing at the same app:

```bash
npm install
cp .env.example .env     # token + client id
npm run register
```

Or as a one-off inside Railway: temporarily set the service's start command to
`node dist/commands/register.js`, deploy, watch it log `Registered 1 command(s)`,
then set it back to `node dist/index.js`.

Leave `DEV_GUILD_ID` empty in production so the command registers globally. Set
it to a server ID while developing — guild commands appear instantly, global
ones can take up to an hour the first time.

---

## Backing up

The whole bot's state is one file. With the Railway CLI:

```bash
railway run cat /data/camelot.sqlite > camelot-backup.sqlite
```

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
