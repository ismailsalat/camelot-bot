#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo '[Camelot TV] Setting up Node and Python, no Docker.'
for cmd in sudo dnf; do command -v "$cmd" >/dev/null || { echo "Missing $cmd. FedoraLinux-44 required."; exit 2; }; done
sudo dnf install -y nodejs npm curl git python3 python3-pip ffmpeg-free dejavu-sans-fonts
encoders="$(ffmpeg -hide_banner -encoders 2>/dev/null)"
if ! grep -Fq libopenh264 <<<"$encoders"; then
  echo 'WARNING: libopenh264 missing. Streaming may fail, catalog still works.'
fi
bash PREPARE-AND-VERIFY.sh
TV_VENV="$HOME/.local/share/camelot-tv/venv"
if [[ ! -x "$TV_VENV/bin/python" ]]; then mkdir -p "$(dirname "$TV_VENV")"; python3 -m venv "$TV_VENV"; fi
if ! "$TV_VENV/bin/python" -c 'import discord, nacl, davey, dave' >/dev/null 2>&1; then
  bash scripts/install-python-deps.sh "$TV_VENV"
fi
"$TV_VENV/bin/python" -m pip check
npm ci --ignore-scripts --no-audit --no-fund
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
echo '[Camelot TV] SETUP COMPLETE. Double-click START-CAMELOT-TV.bat.'
