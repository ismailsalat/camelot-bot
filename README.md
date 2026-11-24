# Camelot Streaming update

Start with [STREAMING.md](STREAMING.md) for the new module and Railway deployment.
All four modules are described below. Existing clips, activity and purge data are preserved.

# 👑 Camelot

A simple Discord bot for a small friend server.

- **Streaming**: watch together with controls in VC chat, episode switching, seeking, source choices and one controller at a time.
- **Clips**: media posts get reactions automatically, with a weekly winner.
- **Activity**: counted messages and shared voice time. No message text or audio is stored.
- **The Purge**: review members one at a time. Nobody is removed until you confirm.

## Updating

Use [UPDATE.md](UPDATE.md). The included `patch.mjs` installs the complete update and backs up replaced source files. It preserves `.env`, `data/`, and `.git`. Build successfully before pushing.

## Quick start

```bash
npm install
cp .env.example .env     # paste your bot token + application id
npm run register         # optional: Camelot also does this itself at boot
npm run dev              # start with live reload
```

Then in Discord: **`/settings`** → **Channels** to pick your clips channel and
which channels Activity should count. **`/settings` → Bot Status** tells you if
anything is misconfigured.

For production:

```bash
npm run build && npm start
```

## Discord Developer Portal setup

1. Go to <https://discord.com/developers/applications> → **New Application** → name it Camelot.
2. **Bot** tab → **Reset Token** → copy it into `DISCORD_TOKEN` in `.env`.
3. **General Information** → copy **Application ID** into `DISCORD_CLIENT_ID`.
4. **Bot** tab → *Privileged Gateway Intents* → turn **MESSAGE CONTENT INTENT** on.
   This is required: without it Discord sends empty `content` for other people's
   messages, so Camelot cannot tell "look at this 😂 + video" from a text-only
   post, and `#clips` would delete everything or nothing.
   **Server Members** and **Presence** are *not* needed — leave them off.
5. Invite the bot (swap in your application ID):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=355392&scope=bot%20applications.commands
```

### What each permission is for

| Permission | Why |
|---|---|
| View Channels | See the games, clips and voice channels |
| Send Messages | Post the panel, sessions, warnings, weekly winner |
| Embed Links | Let posted media links render a preview |
| Read Message History | Re-read clips when tallying votes |
| Manage Messages | Delete non-media posts, pin the panel, enforce one vote per side |
| Add Reactions | Put 👍 👎 on each clip |
| Use External Emojis | Allow custom emojis from another server as vote emojis |

Camelot never joins voice — it only links you to a channel — so it needs no voice permissions beyond *View Channels*.

### Gateway intents in code

| Intent | Privileged | Used for |
|---|---|---|
| `Guilds` | no | channels, roles, basic state |
| `GuildMessages` | no | seeing new posts in `#clips` |
| `MessageContent` | **yes** | reading message text to detect media links |
| `GuildMessageReactions` | no | vote reactions |
| `GuildVoiceStates` | no | who is already sitting in each VC |

---

## Deploying to Railway

See **[DEPLOY.md](DEPLOY.md)** for the step-by-step version. The short form:

1. Push this folder to a GitHub repo.
2. Railway → **New Project** → **Deploy from GitHub repo**. The included
   `Dockerfile` and `railway.json` are picked up automatically.
3. **Variables** → add `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and
   `DATABASE_PATH=/data/camelot.sqlite`.
4. **Add a Volume**, mount path `/data`. Without it the database is wiped on
   every deploy and your settings and sessions go with it.
5. Nothing to run — Camelot publishes its slash commands itself on first boot.

---

## The commands

| Command | Also | Who | What |
|---|---|---|---|
| `/help` | `!help` | everyone | What Camelot does, generated from the live command registry |
| `/settings` | — | admins | One place to configure everything |
| `/stream` | `!stream` | everyone | Open Streaming controls in your VC |
| `/activity` | `/allies`, `!allies` | everyone | Your own activity; admins can look up anyone |
| `/purge` | `!purge @someone` | admins | Review members one at a time |

`/activity` and `/purge` both take a mention, which skips the browsing:

```
/allies @gail        her activity card
/purge @gail         straight to her review card, with a confirmation step
```

Clips needs no command — it just works in the channel you point it at.

### Text commands

The same commands work with a prefix, which is faster to type than finding
someone in a list:

```
!allies          !allies @gail
!help            !purge @gail
```

`COMMAND_PREFIX` sets the default (see `.env.example`). Any server owner can
override it for their own server in `/settings` → Modules → **Change prefix**,
and clear it to follow the host default again. Text commands can be switched
off entirely on the same screen.

A prefix must be 1–3 symbols. Letters and digits are rejected, because they
would turn ordinary sentences into commands, and so are `/`, `@`, `#`, `<` and
a backtick, which Discord treats specially. A bad value falls back to `!`
rather than stopping the bot.

Two commands are deliberately slash-only, because a text command answers with a
message everyone in the channel can read:

- `!settings` points you at `/settings` — channel ids and role setup are not
  for a public channel.
- `!purge` with nobody named points you at `/purge`, so a whole swipe review
  never plays out in public. `!purge @someone` works normally.

A text command doesn't count as activity. Otherwise `!allies` would be a way to
farm the number `!allies` reports.

### Keeping Discord in step

Camelot checks Discord’s registered commands at boot and repairs missing entries. It also registers `/stream` in joined servers and retries failed startup syncs. Use `!stream` if the slash menu is unavailable; it opens the same VC controls.

`npm run register` still exists if you prefer to do it by hand.

## Modules

**Core** is always on: help, settings, permissions, command registration.
**Streaming**, **Clips**, **Activity** and **The Purge** can each be switched off in
`/settings → Modules`. The Purge depends on Activity, so turning Activity off
turns The Purge off too and says why. A disabled module stops doing work —
its event handlers return immediately.

## Clips

Any real media is welcome, with or without a caption: uploaded video, images,
GIFs, stickers, and links to TikTok, Instagram, YouTube (including Shorts),
Twitch clips, X, Streamable, Tenor, Giphy, Imgur, Reddit, Medal and any host
you add. A caption with a clip attached is fine; the same message with nothing
attached is removed.

**Late link previews are handled.** Discord sometimes attaches a preview a
moment after the message lands, so an unrecognised link is held, re-read after
a grace period, and only then judged. Nothing is ever downloaded or scraped —
Camelot reads Discord's own message metadata.

Reactions use the **Thumbs up / Thumbs down** emoji slots, so changing them is
one edit in `/settings → Emojis`. Each clip remembers which emojis it was
reacted with, so changing them later never discards votes already cast.

Friday at 20:00 the highest-scoring clip of the week is posted, linking back to
the original. Nothing is re-uploaded, and the week is claimed in the database
before posting so a restart can't announce twice.

**Clip health** lives in `/settings → Clips`: channel, reactions, permissions
and emoji reachability, each with a short explanation when something is wrong.

## Activity

Two things are counted, and only two:

**Messages** — a message counts when it is long enough, isn't a repeat, and
isn't part of a monologue, capped at **12 a day**. The gap required adapts:
**8 seconds** when other people are talking, **45** when you're talking to
yourself. That's the difference between a debate and spam — a real argument is
fast *because* several people are in it, while a flood is one person alone.
Only a message's length and a one-way fingerprint are read; the text is never
stored and the fingerprints live in memory for ten minutes.

**Voice** — time in a channel with **at least one other real person**. Alone or
with bots earns nothing, AFK is excluded, and joins, leaves, moves and
disconnects are all handled. Up to **3 hours a day** counts toward the score,
but the real total is what gets displayed, so the number you see isn't a lie.
No audio is recorded, and being connected is never reported as speaking.

A day is **active** at 15 voice minutes or 5 counted messages, in the server's
timezone — and it counts the moment you cross that line, not at midnight.
Voice time, messages, active days and the score are all live.

What *does* need real days to build up is **observed history**: the bot records
how much of each day it was running, and a day only counts as observed once it
has seen most of it. That history is what the inactivity estimate and trend
rest on, and what The Purge waits for before it will judge anyone.

**Channels** use two simple modes, set separately for text and voice in
`/settings → Channels`: **all channels except the ones you exclude**, or
**only the ones you pick**. The exclude list wins either way, and AFK never
counts.

You can pick a **whole category**, which is what makes "join to create" servers
work: a voice channel created a second ago still counts because its category
was chosen. Threads count toward the channel they hang off, and lobby channels
named like *Join to Create* are excluded automatically when Camelot joins.

**Coverage is tracked too.** Camelot records how much of each day it was
actually running, so an outage shows as "not tracked" rather than making
someone look inactive. Three states, kept distinct everywhere:
`▰` active · `▱` quiet · `·` not tracked. Days are stepped as calendar dates,
not as 24-hour jumps, so a daylight-saving change can't double-count a day.

### The two models

**Activity score (0–100)** over a rolling 30 days:

```
D = min(activeDays / 12, 1)        35%
V = min(scoredVoiceHours / 24, 1)  35%
M = min(countedMessages / 100, 1)  20%
R = 2^(-daysSinceLastActive / 10)  10%
```

With no recorded activity, R is 0 rather than decaying from 1. Below the
configured observation threshold the result is marked **provisional**.

**Estimated inactivity** — the chance of fewer than two active days in the next
14, from a Beta(2,5) prior updated with what was observed, evaluated as a
beta-binomial with log-gamma for numerical stability. The reference values are
asserted in the test suite: n=30 gives **81.43%** at s=0, **56.72%** at s=2 and
**5.59%** at s=10.

Both are measurements, not verdicts. A low score means little measured
activity, which is not the same as a bad member, and **nobody is ever removed
automatically**.

**Trends** compare the last seven fully observed days with the seven before,
and say nothing at all unless both windows have enough coverage and enough
signal to be worth reading.

## The Purge

`/purge` → one tap: **Inactive only**, **Everyone I can remove**, or
**Everyone**. Each button shows how many people it would bring up. Then one
member per card:
avatar, score, bar, voice, messages, active days, last active, trend, estimated
inactivity and the 30-day timeline.

**Keep · Purge · Skip · Back.** Each press saves the decision and edits the
same message to show the next person — no new messages, no re-queries, no
regenerated images. The candidate list is a bounded snapshot taken once.

When somebody can't be removed — the owner, a protected role, or a role above
Camelot's — the card turns blue, says **🛡️ Can't remove this one** with the
reason, and offers a single **Next member →** button. No guessing why a button
is greyed out.

The inactivity filter uses observed history rather than a low score: a member
needs the configured quiet period, **21 fully observed days of tracking**, and
to be past the **30-day newcomer grace period** before they can appear.

Nothing happens until the end, where you get the counts and the exact list.
Before any kick, every member is re-checked: still present, not the owner,
actor still an admin, bot still permitted, role hierarchy allows it, protection
and exemptions as they stand now, data still reliable, and **no new activity
since you decided**.

The confirmation screen sorts what it found into three groups:

- **Ready** — nothing to flag
- **Flagged** — a caution, with the reason; yours to override
- **Can't be removed** — a wall, with no override

Overriding a caution gets its own confirmation screen listing each person and
what is being overridden. Five or more removals also asks you to type the
number. Failures are handled one at a time, every outcome is logged, and
nothing is announced publicly.

### Protected roles

Identity roles are not protection. **Knights** and **Ladies of Camelot** stay
ordinary unless you say otherwise; set the roles that genuinely protect — like
**The Round Table** — in `/settings → Permissions`.

Role policies are evaluated in priority order and **the first match decides** —
they never stack.

Protection is a caution, not a veto. An admin who has looked at the person is
better placed to judge than a role list is, so a protected member keeps a
working **Purge anyway** button and the reason is shown plainly on the card.

Absolute protection is the exception, and it is deliberately narrower: it is a
hard wall for admins, and a caution for the server owner whose list it is. Set
it on roles you want putting out of an admin's reach.

The server owner can never be removed by anyone, because Discord refuses it.

### Temporary exemptions

Someone away for exams, work or travel can be marked **Away** from their
activity card (owner only) for 7, 14, 30 or 90 days. They drop out of
inactivity review, the exemption shows when reviewing them, it expires on its
own, and nothing is announced.

## Permissions

**Members** see Help, Streaming and their own activity. **Admins** — Manage Server, or any
role you name — get the groups the owner delegates. **The owner** controls
everything, including which groups admins may touch.

Admins can never delegate themselves owner powers: Modules and Permissions are
not delegatable, so the admin-roles list stays the owner's alone. Every check
runs server-side on each interaction — hiding a button is never the control.

## Project layout

```
src/
  index.ts              client, intents, event wiring, graceful shutdown
  core/
    registry.ts         every module and command — the single source of truth
    permissions.ts      member / admin / owner, checked server-side
    ui.ts               the whole visual language: accent, bar, timeline
    help.ts             /help, generated from the registry
    settingsUi.ts       /settings screens
    status.ts           the health checks behind Bot Status
    router.ts           every interaction
    commands.ts  ids.ts
  features/             clips: media rules, guard, voting, clip of the week
  streaming/            TV panel, account settings and worker bridge
  activity/
    model.ts            the two models — pure and fully tested
    store.ts            daily aggregates and coverage
    summary.ts          one pass per member
    tracker.ts          message and voice events
    jobs.ts             coverage heartbeat and daily upkeep
    ui.ts
  purge/
    policy.ts           protection, non-stacking, candidate selection
    session.ts          review snapshots, decisions, logs
    execute.ts          re-validation and kicks
    ui.ts
  test/                 112 tests
parked/fantasy-espn/    ESPN work, parked and not wired in
```

## Commands

| Script | Does |
|---|---|
| `npm run dev` | Run with live reload |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled bot |
| `npm run register` | Publish slash commands (removes any that no longer exist) |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type check without emitting |

## Privacy

Camelot stores counters and daily totals — never message text, never audio,
and nothing from channels you haven't listed. Tracked channels are visible in
`/settings → Channels`. Daily summaries are kept for 180 days and removal logs
for a year, both configurable. The owner can pause tracking or clear all
activity data from `/settings → Activity`; that wipe touches activity only.
Private review notes are never shown publicly.

## Troubleshooting

**Run `/settings` → Bot Status first.** It checks every channel permission,
flags unreachable emojis, and says whether tracking has enough history yet.

| Symptom | Cause |
|---|---|
| Nothing happens when *you* post in `#clips` | Moderator bypass is on and you have Manage Messages. Turn it off in `/settings → Clips` |
| Everything in `#clips` gets deleted | **Message Content** intent is off |
| No 👍 👎 | Missing Add Reactions, or a custom emoji from a server the bot isn't in |
| Activity shows nothing | Tracking needs a full day before anything is "observed" |
| The Purge says nobody is inactive | It needs 21 fully observed days before judging anyone |
| `/purge` missing | Needs Activity on, and Kick Members for the bot |
| Commands missing | Use `!stream`; check Railway logs for `Camelot Streaming v13` and command sync errors |
| `!allies` does nothing | Check the prefix in `/settings` → Modules, and that text commands are on |
| `npm install` fails on `better-sqlite3` | Native module. The Dockerfile installs what it needs; locally you may need build tools |

## Known limits

- Vote tallies read up to 100 reactors per emoji per clip.
- A review queue is capped at 100 members per session.
- Voice time in progress when the bot is killed is banked on a clean shutdown;
  after a crash it is discarded rather than guessed.
- The leaderboard considers members with recorded activity in the window.
