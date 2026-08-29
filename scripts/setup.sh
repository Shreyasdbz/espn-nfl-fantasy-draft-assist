#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"
requested_mode="${1:-}"
mode_normalized="$(printf '%s' "${requested_mode}" | tr '[:upper:]' '[:lower:]')"

case "${mode_normalized}" in
  practice) environment="PRACTICE" ;;
  real|live) environment="LIVE" ;;
  *)
    echo "Usage: ./scripts/setup.sh practice|real" >&2
    exit 2
    ;;
esac

cd "${repo_root}"

command -v node >/dev/null 2>&1 || { echo "Node.js 22.13+ is required." >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "pnpm 10 is required. Run: corepack enable" >&2; exit 1; }
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major<22 || (major===22 && minor<13)) { console.error(`Node ${process.versions.node} is too old; install 22.13+.`); process.exit(1); }'

if [[ ! -d node_modules/.pnpm ]]; then
  echo "Installing locked dependencies..."
  pnpm install --frozen-lockfile
else
  echo "Dependencies already installed."
fi

data_dir="${FDA_DATA_DIR:-$(node -e 'const os=require("node:os"); const path=require("node:path"); process.stdout.write(path.join(os.homedir(),"Library","Application Support","Fantasy Draft Assistant"));')}"
runtime_dir="${data_dir}/runtime"
log_path="${runtime_dir}/fourth-down.log"
mkdir -p "${runtime_dir}"

running="$(pnpm --silent app:doctor | node -e 'let value=""; process.stdin.on("data",chunk=>value+=chunk); process.stdin.on("end",()=>{const start=value.indexOf("{"); const report=JSON.parse(value.slice(start)); process.stdout.write(String(report.runtime.running));});')"
if [[ "${running}" != "true" ]]; then
  if curl --silent --fail --max-time 1 http://127.0.0.1:3000/api/engine/v1/health >/dev/null 2>&1; then
    echo "Fourth Down services answer on port 3000, but the recorded supervisor is not running." >&2
    echo "Stop the orphaned local processes before retrying; setup will not overwrite live ports." >&2
    exit 1
  fi
  echo "Checking for stale runtime metadata..."
  pnpm --silent app:repair-runtime
  echo "Starting Fourth Down under the user launchd session..."
  printf '\n=== setup %s mode=%s ===\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${environment}" >>"${log_path}"
  node "${script_dir}/launch-runtime.mjs" start "$(command -v pnpm)" "${repo_root}" "${data_dir}" "${log_path}"
else
  echo "Fourth Down is already running."
fi

ready=false
for _attempt in {1..40}; do
  if curl --silent --fail --max-time 1 http://127.0.0.1:3000/api/engine/v1/health >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.25
done
if [[ "${ready}" != "true" ]]; then
  echo "Fourth Down did not become ready. Inspect ${log_path}" >&2
  tail -n 30 "${log_path}" >&2 || true
  exit 1
fi

curl --silent --fail --max-time 5 \
  --request PUT \
  --header 'content-type: application/json' \
  --header 'x-fda-csrf: local-ui-v1' \
  --data "{\"environment\":\"${environment}\"}" \
  http://127.0.0.1:3000/api/engine/v1/settings/draft-environment >/dev/null

echo
echo "Fourth Down is ready in ${environment} mode."
echo "App:       http://127.0.0.1:3000"
echo "Extension: ${repo_root}/apps/chrome-extension"
echo "Log:       ${log_path}"
echo
"${script_dir}/validate-connections.sh" --expect-mode "${mode_normalized}"
echo
echo "Next: leave Chrome running, open the correct ESPN draft tab, then run:"
echo "  pnpm app:status:espn"
