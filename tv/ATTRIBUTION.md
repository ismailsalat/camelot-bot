# Source attribution

This build includes an independent AniNeko provider adapter written in JavaScript from the approach documented in [Kuhi anime-api](https://github.com/aryaniiil/anime-api/blob/main/src/providers/anineko.py), licensed MIT. The implementation is not a verbatim copy; it only parses HTML and resolves candidate HLS URLs.

The underlying anime-sdk (MIT) and Slopsoil (GPL-3.0) are third-party dependencies. Consult their licenses before redistributing this project. This project does not include any anime video, browser extension, DRM decryption, or automatic downloading. It cannot guarantee access to copyrighted streams.

The HiAnime adapter uses the protocol documented by pystardust/ani-cli (GPL-3.0), reviewed from its master source on 2026-11-23. It parses data without executing remote JavaScript.

Additional provider implementations come from @consumet/extensions 1.8.8. Its MIT license ships with that npm dependency. These adapters are not a guarantee that the upstream websites are reachable.

The added runtime/live_session.py replaces use of upstream engine.py for lifecycle ownership. The pinned upstream files themselves remain byte-identical and continue to be verified during build.

The color-bar assets are generated locally from FFmpeg's SMPTE test source with Camelot text and a moving indicator. They do not reuse the supplied stock-image watermark or image pixels.
