#!/usr/bin/env bash
# install.sh — vendor the multi-review plugin into a target project.
#
# Usage:
#   bash install.sh [target-dir]
#
#   target-dir   project to install into (default: current directory)
#
# What it does:
#   1. Copies the plugin source into <target>/.opencode/plugins/multi-review/
#      (an immediate plugin package directory, auto-discovered by OpenCode at
#      startup — no "plugins" config entry is needed or written).
#   2. Ensures <target>/.opencode/package.json declares the `@opencode/plugin`
#      dependency; OpenCode runs `bun install` in that directory at startup.
#
# The vendored copy is self-contained: it keeps working even if this repo is
# moved or deleted. Re-run this script to refresh the snapshot. Nothing is
# installed globally.

set -euo pipefail

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  -*) echo "Unknown option: $1" >&2; usage; exit 1 ;;
esac

TARGET="${1:-$PWD}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$TARGET" ]]; then
  echo "error: target directory does not exist: $TARGET" >&2
  exit 1
fi
for f in index.ts reviewers.ts runner.ts report.ts package.json; do
  if [[ ! -f "${PLUGIN_DIR}/$f" ]]; then
    echo "error: plugin source file not found at ${PLUGIN_DIR}/$f — install.sh must sit next to the plugin sources." >&2
    exit 1
  fi
done

TARGET_ABS="$(cd "$TARGET" && pwd)"

# 1. Vendor the plugin sources (no node_modules) into the target.
DEST="$TARGET_ABS/.opencode/plugins/multi-review"
rm -rf "$DEST"
mkdir -p "$DEST"
for f in index.ts reviewers.ts runner.ts report.ts package.json README.md; do
  [[ -f "${PLUGIN_DIR}/$f" ]] && cp "${PLUGIN_DIR}/$f" "$DEST/"
done

# 2. Ensure the config-directory package.json declares the plugin dependency
#    (per OpenCode docs: local plugins that import external packages need a
#    package.json in the .opencode config directory; OpenCode installs it at
#    startup). Machine-independent — safe to commit.
DEP='@opencode/plugin'
CONFIG_PKG="$TARGET_ABS/.opencode/package.json"
mkdir -p "$(dirname "$CONFIG_PKG")"
if [[ -f "$CONFIG_PKG" ]]; then
  if grep -q "\"$DEP\"" "$CONFIG_PKG"; then
    echo "note: $DEP already declared in ${CONFIG_PKG#$TARGET_ABS/}"
  else
    # Append the dependency via node if available; otherwise tell the user.
    if command -v node >/dev/null 2>&1; then
      node -e '
        const fs = require("fs");
        const p = process.argv[1], dep = process.argv[2];
        const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
        pkg.dependencies = { ...(pkg.dependencies ?? {}), [dep]: "^2.0.30" };
        fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
      ' "$CONFIG_PKG" "$DEP"
      echo "added $DEP to ${CONFIG_PKG#$TARGET_ABS/}"
    else
      echo "note: add \"dependencies\": { \"$DEP\": \"^2.0.30\" } to ${CONFIG_PKG#$TARGET_ABS/} (node not on PATH to edit automatically)"
    fi
  fi
else
  printf '{\n  "dependencies": {\n    "%s": "^2.0.30"\n  }\n}\n' "$DEP" > "$CONFIG_PKG"
  echo "created ${CONFIG_PKG#$TARGET_ABS/} with the $DEP dependency"
fi

echo
echo "vendored multi-review plugin into ${DEST#$TARGET_ABS/}/"
echo "  files: $(ls "$DEST" | tr '\n' ' ')"
echo
echo "Next steps:"
echo "  1. Restart OpenCode in $TARGET_ABS (opencode service restart)"
echo "  2. Run:  /multi-review <optional spec>   (or ask the agent to use the multi_review tool)"
echo "  3. Reviewers: quality, bugs, spec, architecture, security (all run by default)"
