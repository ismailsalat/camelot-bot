# Streaming v13

- Fixed missing `/stream` registration recovery and added server-scoped registration.
- Added a working `!stream` entry that opens the same controls.
- Updated Help and setup wording with the text fallback.
- Added 11 regression tests. See UPDATE.md to apply this release.

# Streaming v12

- Streaming appears in Help, Settings, Modules and Bot Status.
- Saved-account status and a Check account button make setup clearer.
- Fixed episode cleanup races, premature success replies, stale seek positions and Stop cancellation.
- Panel updates recover after temporary Discord failures.
- Added regression tests and a standalone patch installer with backups.
- See UPDATE.md for installation and STREAMING.md for setup and test limits.

# What changed

## 1. Admins and the owner have the final say

The Purge used to refuse a removal whenever Camelot was unsure about its own
data. That was wrong: "I don't have enough history" is not the same as "this
isn't allowed", and only one of those is Camelot's call.

Every reason now falls into one of two groups.

**Cautions — you can override these.** Camelot shows what it knows and you
decide:

- Thin tracking history
- They've been active since you reviewed them
- They have a protected role
- They're marked as away

**Walls — nobody overrides these**, because they aren't settings:

- The server owner (Discord refuses outright)
- A role above Camelot's own
- Camelot missing the Kick Members permission
- An absolute-protection role — a wall for admins, a caution for the owner
  who locked it

A protected member now keeps a working **Purge anyway** button on the review
card instead of being shown as a dead end. There's a test asserting an
override can never reach a wall even if something explicitly asks it to.

## 2. A confirmation step before anything happens

- `/purge @someone` → their card → **Remove** → **Are you sure?** → removed
- Overriding a caution in the batch flow gets its own confirmation screen that
  lists each person and the caution being overridden
- Five or more people still asks you to type the number

## 3. Short commands, and text commands

`/allies` does exactly what `/activity` does. Both take a mention:

```
/allies              your own card
/allies @gail        hers (admins)
/purge @gail         straight to her review card
```

And the same commands work as text commands:

```
!allies          !allies @gail
!help            !purge @gail
```

**The prefix is configurable.** `COMMAND_PREFIX` in the environment sets the
default; each server's owner can override it in `/settings` → Modules →
**Change prefix**, so one bot can serve a server that wants `!` and another
that wants `?`. Clear it to follow the host default again.

Two deliberate limits:

- `!settings` points you at `/settings`. A text command answers with a visible
  message in the channel, and your channel ids and role setup don't belong
  there.
- `!purge` with nobody named points you at `/purge`, for the same reason — a
  whole swipe review playing out in `#general`, scores and all, would be worse
  than useless. `!purge @someone` works exactly as asked.

`!allies` doesn't count as activity. Otherwise `!allies` would be a way to
farm the number `!allies` reports.

## 4. Commands publish themselves

`/allies` is new and `/activity` now takes a mention, so Discord needs telling.
Camelot does that itself at boot, and only when the command set has actually
changed — so restarts make no API call and stay clear of Discord's daily
limit on command writes.

You don't need to run `npm run register` any more. It still works if you want
it.

## 5. Smaller fixes

- A failed permission check now replies privately instead of replacing the
  card. On a public text-command panel, one person pressing a button they
  weren't allowed to used to wipe the card for everyone reading it.
- Updates to an existing card no longer re-send the ephemeral flag, which was
  never editable anyway.
- `!allies` typed in `#clips` is no longer deleted as "not media".
- Looking up someone who has left no longer logs an error. Camelot fetches
  possibly-departed members on nearly every screen, and those lines were
  burying the real failures.
- Removal lists — the confirmation screens, the queued list, the outcome — now
  use mentions, so you can check a profile at the moment it matters most.
  Nothing pings; there's a test that reads the source and fails if any payload
  forgets to suppress mentions.
- `patch.mjs` is gone — everything it did is in the source now.
- Leaderboard and purge-card mentions are included.
