#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
VENV="${1:-.cloud-venv}"
[[ -x "$VENV/bin/python" ]] || { echo 'ERROR: Python venv missing'; exit 1; }
mkdir -p .verified-source-downloads
python3 - <<'PY_HASH'
import hashlib
from pathlib import Path
from urllib.request import Request, urlopen
p=Path('.verified-source-downloads/discord-protos-0.0.2.tar.gz')
u='https://files.pythonhosted.org/packages/3a/7c/4b9eaf1f85caa5ff93caa948ee47a2fc5be2d2bbd4b60d3f989da84c8140/discord-protos-0.0.2.tar.gz'
want='23953a05f32beedb40b708ec4b457530a6196a49c8d75d337ae9282a2a41c997'
if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()!=want:
    with urlopen(Request(u,headers={'User-Agent':'CamelotTV/0.2'}),timeout=30) as r:
        blob=r.read(512*1024+1)
    if len(blob)>512*1024 or hashlib.sha256(blob).hexdigest()!=want:
        raise SystemExit('Refusing discord-protos source: hash/length mismatch')
    p.write_bytes(blob)
print('Verified discord-protos source SHA-256.')
PY_HASH
"$VENV/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: --no-binary=discord-protos .verified-source-downloads/discord-protos-0.0.2.tar.gz
"$VENV/bin/python" -m pip install --disable-pip-version-check --only-binary=:all: -r requirements-top-level.txt
"$VENV/bin/python" -m pip check
