#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/music-song-fetcher.config.local.json"
DEFAULT_VENV_PYTHON="$SCRIPT_DIR/.venv/bin/python"

if [[ ! -f "$CONFIG_FILE" ]]; then
	echo "Missing config file: $CONFIG_FILE" >&2
	exit 1
fi

if [[ -z "${YTDLP_PYTHON_BIN:-}" && -x "$DEFAULT_VENV_PYTHON" ]]; then
	export YTDLP_PYTHON_BIN="$DEFAULT_VENV_PYTHON"
fi

DOWNLOAD_LIMIT="${1:-}"

cd "$SCRIPT_DIR"

RESOLVED_PROFILE_DIR="${PROFILE_SITE_DIR:-}"
if [[ -z "$RESOLVED_PROFILE_DIR" ]]; then
	RESOLVED_PROFILE_DIR="$(node --input-type=module -e "import('./tool-paths.js').then((toolPaths) => process.stdout.write(toolPaths.resolveProfilePath()))")"
	if [[ -n "$RESOLVED_PROFILE_DIR" ]]; then
		export PROFILE_SITE_DIR="$RESOLVED_PROFILE_DIR"
	fi
fi

if [[ -n "$RESOLVED_PROFILE_DIR" && ! -d "$RESOLVED_PROFILE_DIR" ]]; then
	echo "Resolved profile directory does not exist: $RESOLVED_PROFILE_DIR" >&2
	exit 1
fi

echo "== Music sync start =="
echo "Scripts dir: $SCRIPT_DIR"
if [[ -n "$RESOLVED_PROFILE_DIR" ]]; then
	echo "Profile dir: $RESOLVED_PROFILE_DIR"
else
	echo "Profile dir: resolved inside Node scripts"
fi
echo "Config file: $CONFIG_FILE"
if [[ -n "${YTDLP_PYTHON_BIN:-}" ]]; then
	echo "Python bin: $YTDLP_PYTHON_BIN"
fi

echo
echo "[1/3] Fetching playlist JSON"
node ./music-song-fetcher.js

echo
if [[ -n "$DOWNLOAD_LIMIT" ]]; then
	echo "[2/3] Downloading up to $DOWNLOAD_LIMIT track(s)"
	node ./download-songs.js "$DOWNLOAD_LIMIT"
else
	echo "[2/3] Downloading all tracks"
	node ./download-songs.js
fi

echo
echo "[3/3] Updating songs library"
node ./update-songs-library.js

echo
echo "Music sync complete."