#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -d node_modules/anime-sdk ]] || { echo 'ERROR: Run INSTALL-CAMELOT-TV.bat first.'; exit 2; }
[[ -f runtime/streaming/golive.py ]] || { echo 'ERROR: Streaming source missing. Run INSTALL-CAMELOT-TV.bat first.'; exit 2; }
export PYTHON_BIN="$HOME/.local/share/camelot-tv/venv/bin/python"
export CAMELOT_LOCAL=1
export PORT=3333
export STREAM_QUALITY=720p
export STREAM_FPS=30
export STREAM_VIDEO_BITRATE=2500k
echo '[Camelot TV] Looking for a free local port (starting at 3333)...'
exec node server.mjs
