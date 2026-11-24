# Camelot TV v0.10.0: Dub, subtitles, and source fallback

Your working v0.9 HLS playback fix is included. This update fixes the separate problem where a Sub-only provider prevented the app from trying Dub elsewhere.

## Start

1. Close the old Camelot TV terminal and tab. Keep your v0.9 folder as a backup.
2. Extract this ZIP into a new folder.
3. Run INSTALL-CAMELOT-TV.bat once, then START-CAMELOT-TV.bat.
4. Open the exact printed URL. The page must say **v0.10.0 · DUB + SUBTITLES**.
5. Search **Dr. Stone**, choose **Dr. STONE (2019)**, and wait for the language check.
6. Choose an episode, **Dub**, and **English** subtitles (or **Off**).
7. Click **Check Episode**, or connect the streamer, choose your VC, and click **PLAY**.

## Audio availability

The episode menu combines the exact season's episode lists across matching sources. It shows:

- **Listed:** at least one provider lists that audio version for this episode. The video has not yet been verified.
- **Not listed:** the checked sources do not list that version for this episode. That option is disabled until sources are refreshed. This is not a claim about whether a dub exists anywhere.
- **Unknown:** a source could not be checked or supplied incomplete language information. The option remains selectable.

A Sub-only source is skipped when you choose Dub. The app then tries matching Dub sources. It does not intentionally switch to Sub or another season/episode when Dub fails. The provider's returned language is checked as well.

**Refresh Sources** reruns discovery and episode listings after source changes or new releases.

## Source fallback

All seven adapters supported by this package are enabled by default: AnimeParadise, Anikoto, MegaPlay, AniNeko, AllManga, Gogoanime, and Goyabu. A custom CAMELOT_PROVIDERS environment variable still limits them if configured.

Selecting one provider in the search dropdown no longer prevents fallback discovery. Once a title is selected, the app searches all enabled adapters for that exact title/aliases and checks their episode lists. Separate Dub listings from the same provider are retained. Up to eight distinct stream URLs per listing can be tried. Stop cancels the current verification; network operations can take a few seconds to return.

Provider names are not all independent hosts: for example, Anikoto and MegaPlay can share a video backend. This is all adapters supported by this package, not every anime site on the internet. Hosts can be unavailable or change their APIs. AllManga's current API handshake still needs an upstream update, so a listing from AllManga may fail playback. Goyabu is Portuguese audio and is shown under Other audio; it is not an English Dub fallback.

## Subtitles

English is selected by default. English, Arabic, Spanish, French, Italian, German, Portuguese, and Russian can be selected where the chosen source provides a matching caption track. Off disables separate caption rendering.

The app downloads a small text subtitle file, converts it to ASS, verifies the renderer, and draws captions into the video before encoding. Everyone watching in Discord sees them. No episode files need uploading or downloading to disk. Temporary caption files are removed after checks or shortly after playback is replaced/stopped.

If your requested caption track is absent or fails, the app tries another source. It does not silently claim subtitles are present. If no source supplies the requested separate captions, choose Off to play without a separate track. Captions already burned into a provider's video cannot be removed with Off.

The language selector chooses audio. The subtitle selector is independent: Dub plus English captions is allowed. Tracks come from the provider, so timing and translation quality depend on that provider; English subtitle tracks are not necessarily a verbatim transcript of the English dub.

The installer includes a font package. FFmpeg needs the libass `ass` filter for captions. A missing filter produces an explicit error; Off allows playback without it.

## Main bot connection

See **BOT-CONNECTION.md** and the **integration** folder. Backend clients for Node and Python are included. The main bot will own embeds/buttons and use a private bridge key to control the TV worker. Its existing bot token stays in its host configuration. Server admins configure the voice channel and controller roles, while the server ID comes from the interaction.

This release runs one TV worker per server. Separate instances and keys keep servers isolated. Multi-server embeds and registration will be added to the main bot after its code is supplied. No live main-bot integration was deployed by this update.

## Verification

Live Dr. STONE (2019), episode 1 tests on November 23, 2026 (Pacific time):

| Test | Result |
| --- | --- |
| Anikoto Dub + English caption rendering + audio | Passed; 70 frames over approximately 3 seconds |
| AnimeParadise Sub + English caption rendering + audio | Passed; 70 frames over approximately 3 seconds |
| Search with AnimeParadise selected, then discover alternatives | Passed; 24 episodes, Dub listed on Anikoto and AllManga |
| Generated video with/without captions | Different frame hashes confirmed visible caption rendering |

Live FFmpeg tests used this environment's required network proxy. The full episode and the updated worker's Discord broadcast were not tested here. Your v0.9 Discord playback is confirmed by your logs; this release still needs your local check for Dub and captions.

Run `npm test` for Node checks, and `python3 -m unittest discover -s tests -p 'test_*.py'` for worker checks. Media regression tests use a generated test pattern, not a stored anime clip.
