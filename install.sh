#!/usr/bin/env bash
# install.sh — install the multi-review plugin into a target project.
#
# Usage:
#   bash install.sh [target-dir] [--copy]
#
#   target-dir   project to install into (default: current directory)
#   --copy       copy the plugin source into <target>/.opencode/plugins/multi-review
#                (vendored snapshot) instead of referencing this repo by path
#
# What it does:
#   1. Adds the plugin to the target's `plugins` config in opencode.json(c).
#   2. With --copy, vendors the plugin files (no node_modules) into the target
#      as an auto-discovered directory plugin.
#   3. Existing config is backed up before any modification; if it cannot be
#      parsed, the exact snippet to merge manually is printed instead.
#
# Nothing is installed globally. Requires `node` on PATH.

set -euo pipefail

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

COPY_MODE=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --copy) COPY_MODE=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
    *) TARGET="$arg" ;;
  esac
done
TARGET="${TARGET:-$PWD}"
PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$TARGET" ]]; then
  echo "error: target directory does not exist: $TARGET" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "error: 'node' is required on PATH to run this installer." >&2
  exit 1
fi
if [[ ! -f "${PLUGIN_DIR}/index.ts" ]]; then
  echo "error: plugin entrypoint not found at ${PLUGIN_DIR}/index.ts — install.sh must sit next to the plugin sources." >&2
  exit 1
fi

TARGET_ABS="$(cd "$TARGET" && pwd)"

TARGET="$TARGET_ABS" PLUGIN_DIR="$PLUGIN_DIR" COPY_MODE=$COPY_MODE node <<'NODE_EOF'
const fs = require("node:fs")
const path = require("node:path")

const PLUGIN_DIR = process.env.PLUGIN_DIR
const COPY_MODE = process.env.COPY_MODE === "1"
const TARGET = process.env.TARGET

// --- JSONC handling ---------------------------------------------------------

// Comment/trailing-comma stripper that is string-aware. Note: the trailing
// comma pass operates on the comment-stripped text and assumes ", }" and ", ]"
// sequences do not appear verbatim inside string values (rare; existing config
// is backed up before any write).
function stripJsonc(src) {
  let out = ""
  let inStr = false
  let quote = ""
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = i + 1 < src.length ? src[i + 1] : ""
    if (inStr) {
      out += c
      if (c === "\\") {
        out += next
        i++
      } else if (c === quote) {
        inStr = false
      }
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i + 1 < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++
      i++
      continue
    }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

function parseConfig(text) {
  const parsed = JSON.parse(stripJsonc(text))
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("top-level config is not an object")
  }
  return parsed
}

// --- locate or create the target config --------------------------------------

const candidates = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]
let configFile = null
let config = {}
for (const rel of candidates) {
  const abs = path.join(TARGET, rel)
  if (fs.existsSync(abs)) {
    configFile = abs
    try {
      config = parseConfig(fs.readFileSync(abs, "utf8"))
    } catch (cause) {
      console.error(`error: ${rel} could not be parsed as JSONC (${cause.message}).`)
      console.error("Merge this manually:\n")
      console.error(JSON.stringify({ plugins: [{ package: COPY_MODE ? path.join(TARGET, ".opencode/plugins/multi-review") : PLUGIN_DIR }] }, null, 2))
      process.exit(1)
    }
    break
  }
}
if (!configFile) {
  configFile = path.join(TARGET, "opencode.jsonc")
  config = { $schema: "https://opencode.ai/config.json" }
}

// --- copy mode: vendor the plugin source --------------------------------------

let packageRef = PLUGIN_DIR
if (COPY_MODE) {
  const dest = path.join(TARGET, ".opencode", "plugins", "multi-review")
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.rmSync(dest, { recursive: true, force: true })
  fs.cpSync(PLUGIN_DIR, dest, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      if (base.startsWith(".")) return false
      if (base === "node_modules" || base === "package-lock.json") return false
      // Vendor only the plugin sources + manifest; repo-level files
      // (install.sh, opencode.jsonc, tsconfig.json, .gitignore) stay behind.
      if (src === PLUGIN_DIR) return true
      return ["index.ts", "reviewers.ts", "runner.ts", "report.ts", "package.json", "README.md"].includes(base)
    },
  })
  packageRef = dest
}

// --- merge -------------------------------------------------------------------

if (!Array.isArray(config.plugins)) config.plugins = []
const already = config.plugins.some((p) => (typeof p === "string" ? p : p && p.package) === packageRef)
if (!already) config.plugins.push({ package: packageRef })
else console.log("note: plugin is already present in the target's plugins config")

// --- write (with backup) -----------------------------------------------------

if (fs.existsSync(configFile)) {
  const backup = `${configFile}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`
  fs.copyFileSync(configFile, backup)
  console.log(`backed up existing config to ${backup}`)
}
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", "utf8")

console.log(`\ninstalled multi-review plugin into ${configFile}`)
console.log(`  plugin: ${packageRef}${COPY_MODE ? " (vendored copy)" : " (referenced by path)"}`)
console.log(`\nNext steps:`)
console.log(`  1. Open an OpenCode session in ${TARGET}`)
console.log(`  2. Run:  /review <optional spec>   (or ask the agent to use the multi_review tool)`)
console.log(`  3. Reviewers: quality, bugs, spec, architecture, security (all run by default)`)
NODE_EOF
