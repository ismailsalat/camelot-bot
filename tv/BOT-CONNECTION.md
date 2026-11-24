# Connecting the main Camelot bot

The main Camelot bot is the controller. It owns the Discord embeds, search choices, episode selector, Sub/Dub selector, subtitle selector, and Play/Next/Stop buttons. Camelot TV resolves sources and runs the streaming worker.

The supplied clients prepare this connection. They are not installed into your main bot yet; that requires its source code. No Discord commands have been registered or messages sent by this update.

## Credentials and server setup

| Setting | Where it belongs |
| --- | --- |
| Main Camelot bot token | The main bot's existing host configuration, once per bot application |
| Streaming account token | Private TV worker configuration; never in a Discord embed or chat message |
| Server ID | Read from the Discord interaction's guild ID and paired with that server's worker |
| TV service URL and bridge key | Private main bot configuration for that server |
| Voice channel and permitted controller roles | Server-specific admin settings in the main bot |

A server owner installs the same Camelot bot through Discord's invite/OAuth flow. They do not need to supply another bot token to use the existing bot. Someone hosting their own separate copy of the main bot configures their own bot token on their host.

This release runs one streaming session per TV service instance. For multiple servers, run a separate worker service and unique bridge key per guild, then store the pairing by guild ID in the main bot. The bot must select the pairing from the interaction's actual guild, not an ID supplied by a button or user. One worker must not be reused simultaneously for different guilds.

The bridge key allows search, episode lists, checks, playback and stop. It cannot connect or disconnect the streaming account, change its credentials, or read the activity logs. Play/check/stop requests must carry the worker's paired guild ID. The main bot must separately check the member's configured owner/admin/controller role on every interaction, including old buttons.

## Worker settings

Configure `CAMELOT_BRIDGE_KEY` with a random secret of at least 32 characters. Generate one privately, for example with `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.

On Railway, set `CAMELOT_GUILD_ID`, `CAMELOT_STREAMER_TOKEN`, `CAMELOT_ADMIN_KEY`, and `CAMELOT_BRIDGE_KEY` as private service variables. The bot needs only the TV service URL and bridge key, not the streaming token or admin key.

If the main bot and TV run together on the same machine, the bot can use the printed localhost URL. A bot on Railway cannot reach the localhost URL on your Windows computer. Host its TV worker alongside it with HTTPS access, or use a separately configured secure connection. Do not expose the unauthenticated local web interface to the internet.

## Button flow

1. `/tv` opens the panel. Only configured controllers can change playback.
2. Search calls `client.search(title)` and displays selectable seasons.
3. Selection calls `client.episodes(selection)` and stores the returned `selection` and `episodes` in that guild's session.
4. Display each episode's `availability.sub` and `availability.dub`: `listed`, `unknown`, or `not-listed`. Do not call `listed` a verified stream. Unknown stays selectable.
5. A button interaction is acknowledged/deferred immediately, before any network or FFmpeg work. Verify the guild, member role, and selected VC.
6. Play calls `client.play(selection, episode, {channel, audio, subtitles})` in Node, or the equivalent Python keyword arguments. Use the selected episode's opaque ID from the response.
7. Next chooses the next returned episode in that guild's session and calls Play. Never increment a provider-specific ID yourself. Stop calls `client.stop()`.
8. `client.state()` supplies playback status. The initial Play response means verified and requested; mark the panel live only when the worker reports `streaming`.

Use one session lock per guild to prevent double-clicks and simultaneous conflicting controls. Keep tokens, bridge keys, source URLs and subtitle URLs out of embed content and custom IDs. Store only a short random session ID in a button, and retrieve the actual selection from the bot's server-side session store.

## Client examples

Node 20+:

```js
import {CamelotTVClient} from './integration/camelot_tv_client.mjs';
const tv = new CamelotTVClient({
  baseUrl: process.env.CAMELOT_TV_URL,
  apiKey: process.env.CAMELOT_TV_BRIDGE_KEY,
  guildId: interaction.guildId,
});
// After validating the member's role and acknowledging the interaction:
const listing = await tv.episodes(selectedSearchResult);
await tv.play(listing.selection, listing.episodes[0], {
  channel: configuredVoiceChannelId,
  audio: 'dub',
  subtitles: 'en',
});
```

Python 3.10+:

```python
from integration.camelot_tv_client import CamelotTVClient
# Obtain this guild's stored pairing after checking the member's permissions.
tv = CamelotTVClient(pairing.url, pairing.bridge_key, interaction.guild_id)
listing = await tv.episodes(selected_search_result)
await tv.play(listing['selection'], listing['episodes'][0],
              channel=configured_voice_channel_id, audio='dub', subtitles='en')
```

The worker still uses the existing experimental user-account Go Live transport. Connecting an official bot as its controller does not convert that transport into an official bot streaming API. Discord's policy on automated user accounts remains applicable: https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots
