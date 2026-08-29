#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
require_espn=false
expected_mode=""
max_age_seconds=15

while [[ $# -gt 0 ]]; do
  case "$1" in
    --require-espn) require_espn=true; shift ;;
    --expect-mode)
      [[ $# -ge 2 ]] || { echo "--expect-mode requires practice or real" >&2; exit 2; }
      expected_mode="$2"; shift 2
      ;;
    --max-age-seconds)
      [[ $# -ge 2 ]] || { echo "--max-age-seconds requires a number" >&2; exit 2; }
      max_age_seconds="$2"; shift 2
      ;;
    *)
      echo "Usage: ./scripts/validate-connections.sh [--require-espn] [--expect-mode practice|real] [--max-age-seconds 15]" >&2
      exit 2
      ;;
  esac
done

cd "${repo_root}"

echo "Checking SQLite and runtime..."
pnpm --silent app:doctor
echo
node "${script_dir}/validate-connections.mjs" \
  "--require-espn=${require_espn}" \
  "--expect-mode=${expected_mode}" \
  "--max-age-seconds=${max_age_seconds}"
