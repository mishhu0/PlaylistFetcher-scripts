#!/usr/bin/env bash
#
# One-time migration: saves real credentials, pulls latest code,
# restores credentials into the new VPS-friendly config paths.
#
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/music-song-fetcher.config.local.json"
BACKUP_FILE="$SCRIPT_DIR/.config-backup.json"
EXAMPLE_FILE="$SCRIPT_DIR/music-song-fetcher.config.local.json.example"

echo "== Playlist Config Migration =="

# Step 1 — Backup existing credentials
if [ -f "$CONFIG_FILE" ]; then
    echo "[1/4] Backing up current config credentials..."
    node -e "
        const fs = require('fs');
        const cfg = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf-8'));
        const backup = {
            apiKey: cfg.apiKey || '',
            playlistId: cfg.playlistId || '',
            playlistTitle: cfg.playlistTitle || '',
            ytDlp: {
                jsRuntime: cfg.ytDlp && cfg.ytDlp.jsRuntime || 'node',
                jsRuntimePath: cfg.ytDlp && cfg.ytDlp.jsRuntimePath || '/usr/bin/node',
                cookiesPath: cfg.ytDlp && cfg.ytDlp.cookiesPath || '',
                cookiesFromBrowser: cfg.ytDlp && cfg.ytDlp.cookiesFromBrowser || '',
                extraArgs: cfg.ytDlp && cfg.ytDlp.extraArgs || []
            }
        };
        fs.writeFileSync('$BACKUP_FILE', JSON.stringify(backup, null, 2));
        console.log('Saved to .config-backup.json');
    "
else
    echo "[1/4] No existing config found — nothing to back up."
fi

# Step 2 — Remove old config from git tracking to avoid pull conflicts
if git -C "$SCRIPT_DIR" ls-files --error-unmatch "$CONFIG_FILE" &>/dev/null 2>&1; then
    echo "[2/4] Removing old config from git tracking..."
    git -C "$SCRIPT_DIR" rm --cached "$CONFIG_FILE"
fi

# Step 3 — Pull latest code
echo "[3/4] Pulling latest code..."
git -C "$SCRIPT_DIR" pull

# Step 4 — Restore credentials into new config
echo "[4/4] Restoring config with saved credentials..."
if [ -f "$EXAMPLE_FILE" ]; then
    if [ -f "$BACKUP_FILE" ]; then
        node -e "
            const fs = require('fs');
            const example = JSON.parse(fs.readFileSync('$EXAMPLE_FILE', 'utf-8'));
            const backup = JSON.parse(fs.readFileSync('$BACKUP_FILE', 'utf-8'));

            example.apiKey = backup.apiKey || example.apiKey;
            example.playlistId = backup.playlistId || example.playlistId;
            example.playlistTitle = backup.playlistTitle || example.playlistTitle;
            if (backup.ytDlp) {
                example.ytDlp.jsRuntime = backup.ytDlp.jsRuntime || example.ytDlp.jsRuntime;
                example.ytDlp.jsRuntimePath = backup.ytDlp.jsRuntimePath || example.ytDlp.jsRuntimePath;
                example.ytDlp.cookiesPath = backup.ytDlp.cookiesPath || example.ytDlp.cookiesPath;
                example.ytDlp.cookiesFromBrowser = backup.ytDlp.cookiesFromBrowser || example.ytDlp.cookiesFromBrowser;
                example.ytDlp.extraArgs = backup.ytDlp.extraArgs || example.ytDlp.extraArgs;
            }

            fs.writeFileSync('$CONFIG_FILE', JSON.stringify(example, null, 2));
            console.log('Config written with VPS paths + saved credentials.');
        "
        rm -f "$BACKUP_FILE"
    else
        echo "No backup found — copying example as template."
        cp "$EXAMPLE_FILE" "$CONFIG_FILE"
    fi
else
    echo "ERROR: .example file not found after pull!" >&2
    exit 1
fi

echo ""
echo "== Migration complete =="
echo "  Config: $CONFIG_FILE"
echo "  If cookiesPath needs a VPS path, edit it manually."
