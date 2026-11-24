#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
COMMIT="8ba7e071fd89ccc2410b726ff1a99553ba50f554"
SOURCE="$PWD/_slopsoil_upstream"
if [[ ! -d "$SOURCE/.git" ]]; then
  echo "Downloading the FULL Slopsoil source tree at a fixed revision; this does not execute it."
  git clone --no-checkout https://github.com/dev-topsoil/slopsoil.git "$SOURCE"
fi
# Refuse existing local repo worktree changes (could hide modified source).
if ! git -C "$SOURCE" cat-file -e "$COMMIT^{commit}"; then
  git -C "$SOURCE" fetch --quiet origin "$COMMIT" || true
fi
if ! git -C "$SOURCE" cat-file -e "$COMMIT^{commit}"; then
  echo "Pinned revision not available. Aborting." >&2; exit 1
fi
git -C "$SOURCE" checkout --detach --force "$COMMIT" >/dev/null
if [[ "$(git -C "$SOURCE" rev-parse HEAD)" != "$COMMIT" ]]; then
  echo "Commit mismatch" >&2; exit 1
fi
while read -r expected path; do
  [[ -z "${expected:-}" ]] && continue
  actual="$(git -C "$SOURCE" hash-object "$SOURCE/$path")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Unexpected source content: $path" >&2; exit 1
  fi
done < SOURCE-ALLOWLIST.tsv
# Only explicit reviewed subset goes to runtime: no upstream bot.py or integrations.
while read -r expected path; do
  [[ -z "${expected:-}" ]] && continue
  if [[ "$path" == "LICENSE" ]]; then
    cp "$SOURCE/LICENSE" COPYING-GPL-3.0.txt
  else
    mkdir -p "runtime/$(dirname "$path")"
    cp "$SOURCE/$path" "runtime/$path"
  fi
done < SOURCE-ALLOWLIST.tsv
# Check copied bytes, too.
while read -r expected path; do
  [[ -z "${expected:-}" || "$path" == "LICENSE" ]] && continue
  actual="$(git hash-object "runtime/$path")"
  [[ "$actual" == "$expected" ]] || { echo "Copy verification failed: $path" >&2; exit 1; }
done < SOURCE-ALLOWLIST.tsv
python3 -m compileall -q runtime
printf 'Pinned upstream %s / reviewed 8 runtime source files verified\n' "$COMMIT" > SOURCE-VERIFIED-LOCAL.txt
echo "Verified source files. No upstream setup or bot code executed."
