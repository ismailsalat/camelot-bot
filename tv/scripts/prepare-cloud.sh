#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo '[Build] Verifying Slopsoil streaming source files...'
bash PREPARE-AND-VERIFY.sh
python3 -m venv .cloud-venv
bash scripts/install-python-deps.sh .cloud-venv
# The FFmpeg encoder on Railway's Linux image may NOT support the same codecs as Fedora.
# The streamer checks this at runtime; catalog search can still run without it.
echo '[Build] Prepared Python worker. No Discord account was contacted.'
