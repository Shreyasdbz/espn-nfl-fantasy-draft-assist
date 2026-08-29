import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const action = process.argv[2];
const pnpmPath = process.argv[3];
const repoRoot = process.argv[4];
const dataDirectory = process.argv[5];
const logPath = process.argv[6];
const label = 'com.fourthdown.fantasy-draft-assistant';
const domain = `gui/${process.getuid()}`;

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function launchctl(args, allowFailure = false) {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`launchctl ${args[0]} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  }
  return result;
}

if (action === 'stop') {
  launchctl(['bootout', `${domain}/${label}`], true);
  process.exit(0);
}

if (action !== 'start' || !pnpmPath || !repoRoot || !dataDirectory || !logPath) {
  console.error('Usage: node scripts/launch-runtime.mjs start <pnpm> <repo> <data-dir> <log> | stop');
  process.exit(2);
}

const runtimeDirectory = join(dataDirectory, 'runtime');
const plistPath = join(runtimeDirectory, 'fourth-down.launchd.plist');
mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
const pathValue = process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(pnpmPath)}</string>
    <string>dev</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(repoRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${escapeXml(pathValue)}</string>
    <key>FDA_DATA_DIR</key><string>${escapeXml(dataDirectory)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escapeXml(logPath)}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logPath)}</string>
</dict>
</plist>
`;
writeFileSync(plistPath, plist, { mode: 0o600 });
launchctl(['bootout', `${domain}/${label}`], true);
launchctl(['bootstrap', domain, plistPath]);
console.log(`launchd job ${label} loaded from ${plistPath}`);
