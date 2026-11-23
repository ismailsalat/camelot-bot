# ESPN Fantasy Basketball — parked

Work in progress, **not wired into the bot**. Nothing here is imported by
`src/`, nothing here runs, and no fantasy tables are created.

## What exists

- `src-fantasy/domain.ts` — the domain model (league, teams, matchups,
  transactions) that ESPN payloads get mapped onto.
- `src-fantasy/config.ts` — per-guild fantasy config, designed to live in its
  own `fantasy_*` tables so the module can be dropped after the season.
- `src-fantasy/espn/client.ts` — read-only ESPN client: cookie auth from
  `ESPN_S2` / `ESPN_SWID`, TTL cache, request coalescing, and a typed error
  taxonomy (auth / not-found / rate-limited / espn-down / network). It never
  logs or returns credentials.

## What is missing

The transform layer, card rendering, dashboard and interaction UI, the
scheduler jobs, and the `/fantasy` command.

## Status of the ESPN connection

**Unverified.** The ESPN API was never reachable from the build environment, so
no authenticated request has ever succeeded. Treat the client as untested
against the live service.

## To resume

Move `src-fantasy` back to `src/fantasy`, re-add the `003_fantasy` migration
(it was removed so the numbering stayed clean), and continue from the
transform layer.
