import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { DraftRepository, defaultDataDirectory } from '@fda/db';

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

function stop() { const descriptor = readDescriptor(); if (!descriptor || !processAlive(descriptor.supervisorPid)) return console.log('Fantasy Draft Assistant is not running.'); process.kill(descriptor.supervisorPid, 'SIGTERM'); console.log('Stopping Fantasy Draft Assistant.'); }

if (command === 'start') await start(); else if (command === 'doctor') doctor(); else if (command === 'backup') backup(); else if (command === 'stop') stop(); else throw new Error(`Unknown command: ${command}`);
