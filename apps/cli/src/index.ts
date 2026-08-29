import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DraftRepository, defaultDataDirectory } from '@fda/db';
import { readResearchWorkbook } from './research-workbook.ts';
import { readPlayerIntelligence } from './player-intelligence.ts';

const command = process.argv[2] ?? 'start';
const dataDirectory = defaultDataDirectory();
const runtimeDirectory = join(dataDirectory, 'runtime');
const descriptorPath = join(runtimeDirectory, 'runtime.json');
const lockPath = join(runtimeDirectory, 'app.lock');
type Descriptor = { supervisorPid: number; enginePort: number; webPort: number; secret: string; startedAt: string };

function readDescriptor(): Descriptor | null { try { return JSON.parse(readFileSync(descriptorPath, 'utf8')) as Descriptor; } catch { return null; } }
function processAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

async function start() {
  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 });
  const prior = readDescriptor();
  if (prior && processAlive(prior.supervisorPid)) throw new Error(`Fantasy Draft Assistant is already running at http://127.0.0.1:${prior.webPort}`);
  if (existsSync(lockPath)) throw new Error(`A stale runtime lock exists at ${lockPath}. Run app:doctor before removing it.`);
  const lock = openSync(lockPath, 'wx', 0o600); closeSync(lock);
  const descriptor: Descriptor = { supervisorPid: process.pid, enginePort: Number(process.env.FDA_ENGINE_PORT ?? 4317), webPort: Number(process.env.FDA_WEB_PORT ?? 3000), secret: randomBytes(32).toString('hex'), startedAt: new Date().toISOString() };
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 });
  const env = { ...process.env, FDA_DATA_DIR: dataDirectory, FDA_ENGINE_PORT: String(descriptor.enginePort), FDA_ENGINE_SECRET: descriptor.secret, ENGINE_ORIGIN: `http://127.0.0.1:${descriptor.enginePort}`, ENGINE_SECRET: descriptor.secret };
  const engine = spawn('pnpm', ['--filter', '@fda/engine', 'start'], { cwd: process.cwd(), env, stdio: 'inherit' });
  const web = spawn('pnpm', ['--filter', '@fda/web', 'dev', '--hostname', '127.0.0.1', '--port', String(descriptor.webPort)], { cwd: process.cwd(), env, stdio: 'inherit' });
  console.log(`\nFantasy Draft Assistant: http://127.0.0.1:${descriptor.webPort}\n`);
  const cleanup = () => { engine.kill('SIGTERM'); web.kill('SIGTERM'); try { unlinkSync(descriptorPath); } catch {} try { unlinkSync(lockPath); } catch {} };
  process.on('SIGINT', () => { cleanup(); process.exit(0); }); process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  const exitCode = await new Promise<number>((resolve) => { engine.once('exit', (code) => resolve(code ?? 1)); web.once('exit', (code) => resolve(code ?? 1)); });
  cleanup(); process.exit(exitCode);
}

function doctor() {
  const descriptor = readDescriptor();
  const repository = new DraftRepository({ databasePath: join(dataDirectory, 'app.sqlite') });
  const result = repository.integrity(); repository.close();
  console.log(JSON.stringify({ dataDirectory, database: result, runtime: descriptor ? { running: processAlive(descriptor.supervisorPid), startedAt: descriptor.startedAt, webPort: descriptor.webPort } : { running: false } }, null, 2));
  if (!result.ok) process.exitCode = 1;
}

function backup() {
  const repository = new DraftRepository({ databasePath: join(dataDirectory, 'app.sqlite') });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = repository.backup(join(dataDirectory, 'backups', `${stamp}.sqlite`)); repository.close(); console.log(JSON.stringify(result, null, 2));
}

function repairRuntime() {
  const descriptor = readDescriptor();
  if (descriptor && processAlive(descriptor.supervisorPid)) {
    console.log(JSON.stringify({ repaired: false, running: true, supervisorPid: descriptor.supervisorPid, removed: [] }, null, 2));
    return;
  }
  if (!descriptor && existsSync(lockPath)) {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    if (ageMs < 30_000) throw new Error('Runtime lock is less than 30 seconds old; setup may still be in progress. Wait and retry.');
  }
  const removed: string[] = [];
  for (const target of [descriptorPath, lockPath]) {
    if (!existsSync(target)) continue;
    unlinkSync(target);
    removed.push(target);
  }
  console.log(JSON.stringify({ repaired: removed.length > 0, running: false, priorSupervisorPid: descriptor?.supervisorPid ?? null, removed }, null, 2));
}

function importResearch(filePath: string | undefined) {
  if (!filePath) throw new Error('Usage: pnpm app:import -- path/to/research.xlsx');
  const descriptor = readDescriptor();
  if (descriptor && processAlive(descriptor.supervisorPid)) throw new Error('Stop Fantasy Draft Assistant before importing a research workbook.');
  const dataset = readResearchWorkbook(filePath);
  const databasePath = join(dataDirectory, 'app.sqlite');
  const repository = new DraftRepository({ databasePath });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = repository.backup(join(dataDirectory, 'backups', `before-research-import-${stamp}.sqlite`)).path;
    const result = repository.importResearchDataset(dataset);
    const integrity = repository.integrity();
    console.log(JSON.stringify({
      dataDirectory, databasePath, backupPath,
      dataset: {
        source: dataset.sourceFilename, checksum: dataset.checksum, players: dataset.players.length,
        positions: dataset.players.reduce<Record<string, number>>((counts, player) => {
          counts[player.position] = (counts[player.position] ?? 0) + 1;
          return counts;
        }, {}),
        league: dataset.leagueName, team: dataset.teamName, teamCount: dataset.teamCount,
        rounds: dataset.rounds, userSlot: dataset.userSlot,
      },
      result, integrity,
    }, null, 2));
    if (!integrity.ok) process.exitCode = 1;
  } finally {
    repository.close();
  }
}

function importIntelligence(statsPath: string | undefined, rosterPath: string | undefined) {
  if (!statsPath || !rosterPath) throw new Error('Usage: pnpm app:enrich -- path/to/stats_player_week_2025.csv path/to/roster_2026.csv');
  const descriptor = readDescriptor();
  if (descriptor && processAlive(descriptor.supervisorPid)) throw new Error('Stop Fantasy Draft Assistant before importing player intelligence.');
  const dataset = readPlayerIntelligence(statsPath, rosterPath);
  const databasePath = join(dataDirectory, 'app.sqlite');
  const repository = new DraftRepository({ databasePath });
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = repository.backup(join(dataDirectory, 'backups', `before-intelligence-import-${stamp}.sqlite`)).path;
    const result = repository.importPlayerIntelligence(dataset.profiles);
    const integrity = repository.integrity();
    console.log(JSON.stringify({ dataDirectory, databasePath, backupPath, checksum: dataset.checksum, result, integrity }, null, 2));
    if (!integrity.ok) process.exitCode = 1;
  } finally {
    repository.close();
  }
}

function stop() { const descriptor = readDescriptor(); if (!descriptor || !processAlive(descriptor.supervisorPid)) return console.log('Fantasy Draft Assistant is not running.'); process.kill(descriptor.supervisorPid, 'SIGTERM'); console.log('Stopping Fantasy Draft Assistant.'); }

if (command === 'start') await start();
else if (command === 'doctor') doctor();
else if (command === 'backup') backup();
else if (command === 'repair-runtime') repairRuntime();
else if (command === 'import-research') importResearch(process.argv.slice(3).find((argument) => argument !== '--'));
else if (command === 'import-intelligence') {
  const paths = process.argv.slice(3).filter((argument) => argument !== '--');
  importIntelligence(paths[0], paths[1]);
}
else if (command === 'stop') stop();
else throw new Error(`Unknown command: ${command}`);
