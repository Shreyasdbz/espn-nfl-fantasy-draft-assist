#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
skip_backup=false

case "${1:-}" in
  "") ;;
  --no-backup) skip_backup=true ;;
  *) echo "Usage: ./scripts/teardown.sh [--no-backup]" >&2; exit 2 ;;
esac

cd "${repo_root}"
data_dir="${FDA_DATA_DIR:-$(node -e 'const os=require("node:os"); const path=require("node:path"); process.stdout.write(path.join(os.homedir(),"Library","Application Support","Fantasy Draft Assistant"));')}"

if [[ "${skip_backup}" != "true" ]]; then
  echo "Creating a SQLite backup before shutdown..."
  pnpm app:backup
fi

pnpm app:stop
node "${script_dir}/launch-runtime.mjs" stop
sleep 0.5

running="$(pnpm --silent app:doctor | node -e 'let value=""; process.stdin.on("data",chunk=>value+=chunk); process.stdin.on("end",()=>{const start=value.indexOf("{"); const report=JSON.parse(value.slice(start)); process.stdout.write(String(report.runtime.running));});')"
if [[ "${running}" == "true" ]]; then
  echo "Fourth Down is still running." >&2
  exit 1
fi

echo "Fourth Down is stopped. Chrome, ESPN tabs, the extension, and draft data were left untouched."
