import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { DomainEvent, Health } from '@fda/contracts';
import { BindPageCommandSchema, DraftEnvironmentCommandSchema, ManualPickCommandSchema, ResetCommandSchema, SimulateCommandSchema, TabBridgeObservationSchema } from '@fda/contracts';
import { DraftRepository, defaultDataDirectory } from '@fda/db';
import { chooseSimulatedPlayer } from '@fda/simulator';
import { BrowserController } from './browser-controller.ts';
import { buildEspnTabBridge } from './tab-bridge.ts';

const engineInstanceId = randomUUID();
const port = Number(process.env.FDA_ENGINE_PORT ?? 4317);
const secret = process.env.FDA_ENGINE_SECRET ?? randomBytes(32).toString('hex');
const dataDirectory = defaultDataDirectory();
const bridgeTokenPath = join(dataDirectory, 'runtime', 'bridge.token');
function persistentBridgeToken() {
  try { return readFileSync(bridgeTokenPath, 'utf8').trim(); } catch {
    const token = randomBytes(24).toString('base64url');
    mkdirSync(join(dataDirectory, 'runtime'), { recursive: true, mode: 0o700 });
    writeFileSync(bridgeTokenPath, token, { mode: 0o600 });
    return token;
  }
}
const bridgeToken = persistentBridgeToken();
const repository = new DraftRepository({ databasePath: join(dataDirectory, 'app.sqlite') });
const app = Fastify({ logger: true, disableRequestLogging: true, bodyLimit: 1_000_000, trustProxy: false });
app.addContentTypeParser('text/plain', { parseAs: 'string' }, (_request, body, done) => done(null, body));
const listeners = new Set<(event: DomainEvent) => void>();
let sequence = 0;

const emit = (cause: string, type: DomainEvent['type'] = 'draft.state.changed') => {
  const session = repository.getActiveSession();
  const event: DomainEvent = { engineInstanceId, sequence: ++sequence, type, aggregateId: session.id, aggregateRevision: session.revision, cause, occurredAt: new Date().toISOString() };
  for (const listener of listeners) listener(event);
};
const browser = new BrowserController(repository, join(dataDirectory, 'chrome-profile'), (cause) => emit(cause, 'observer.health.changed'));

function health(): Health {
  const integrity = repository.integrity();
  return { engine: integrity.ok ? 'healthy' : 'degraded', database: integrity.ok ? 'healthy' : 'degraded', ...browser.health(), schemaVersion: '0004_player_intelligence', engineInstanceId };
}

app.addHook('onRequest', async (request, reply) => {
  const pathname = request.url.split('?')[0];
  const origin = request.headers.origin;
  const extensionOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  if (pathname === '/v1/bridge/extension-config') {
    if (origin && !extensionOrigin) return reply.code(403).send({ code: 'BRIDGE_REJECTED', message: 'Chrome extension origin required' });
    reply.header('access-control-allow-origin', extensionOrigin ? origin : 'null');
    reply.header('access-control-allow-methods', 'GET, OPTIONS');
    reply.header('access-control-allow-private-network', 'true');
    if (request.method === 'OPTIONS') return reply.code(204).send();
    return;
  }
  if (pathname === '/v1/bridge/observe') {
    const allowedOrigin = origin === 'https://fantasy.espn.com' || extensionOrigin;
    reply.header('access-control-allow-origin', allowedOrigin ? origin : 'null');
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-allow-private-network', 'true');
    if (request.method === 'OPTIONS') return reply.code(204).send();
    const supplied = new URL(request.url, 'http://127.0.0.1').searchParams.get('token');
    if (!allowedOrigin || supplied !== bridgeToken) return reply.code(403).send({ code: 'BRIDGE_REJECTED', message: 'ESPN bridge origin or token rejected' });
    return;
  }
  const host = request.headers.host?.split(':')[0];
  if (host !== '127.0.0.1' && host !== 'localhost') return reply.code(400).send({ code: 'INVALID_HOST', message: 'Loopback host required' });
  if (request.headers.authorization !== `Bearer ${secret}`) return reply.code(401).send({ code: 'UNAUTHORIZED', message: 'Engine bearer secret required' });
  if (request.method !== 'GET' && request.headers['content-type']?.split(';')[0] !== 'application/json') return reply.code(415).send({ code: 'JSON_REQUIRED', message: 'Mutations require JSON' });
});

app.setErrorHandler((error, _request, reply) => {
  const typed = error as Error & { statusCode?: number; code?: string; currentRevision?: number };
  reply.code(typed.statusCode ?? 500).send({ code: typed.code ?? 'INTERNAL_ERROR', message: typed.message, currentRevision: typed.currentRevision });
});

app.get('/v1/health', async () => health());
app.get('/v1/state', async () => repository.getState(health()));
app.put('/v1/settings/draft-environment', async (request) => {
  const parsed = DraftEnvironmentCommandSchema.parse(request.body);
  const result = repository.setDraftEnvironment(parsed.environment);
  await browser.refreshEnvironment();
  emit('draft.environment.changed', 'observer.health.changed');
  return result;
});

app.post('/v1/draft-sessions/:id/manual-picks', async (request) => {
  const parsed = ManualPickCommandSchema.parse(request.body);
  const session = repository.getActiveSession();
  if ((request.params as { id: string }).id !== session.id) throw Object.assign(new Error('Session is not active'), { statusCode: 409, code: 'SESSION_NOT_ACTIVE' });
  const result = repository.applyPick({ commandId: parsed.commandId, expectedRevision: parsed.expectedRevision, playerId: parsed.body.playerId, overallPick: parsed.body.overallPick, authority: 'manual', reason: parsed.body.reason });
  emit('manual.pick'); return result;
});

app.put('/v1/draft-sessions/:id/picks/:pick', async (request) => {
  const parsed = ManualPickCommandSchema.parse(request.body);
  const result = repository.applyPick({ commandId: parsed.commandId, expectedRevision: parsed.expectedRevision, playerId: parsed.body.playerId, overallPick: Number((request.params as { pick: string }).pick), authority: 'manual', reason: parsed.body.reason });
  emit('manual.correction'); return result;
});

app.post('/v1/draft-sessions/:id/simulate', async (request) => {
  const parsed = SimulateCommandSchema.parse(request.body);
  if (repository.getDraftEnvironment() !== 'PRACTICE') throw Object.assign(new Error('Synthetic observations are available only in the practice environment'), { statusCode: 409, code: 'PRACTICE_ENVIRONMENT_REQUIRED' });
  const initial = repository.getState(health());
  if (initial.session.revision !== parsed.expectedRevision) throw Object.assign(new Error(`Expected revision ${parsed.expectedRevision}, current revision is ${initial.session.revision}`), { statusCode: 409, code: 'REVISION_CONFLICT', currentRevision: initial.session.revision });
  let revision = parsed.expectedRevision;
  let applied = 0;
  for (let index = 0; index < parsed.body.count; index += 1) {
    const state = repository.getState(health());
    if (state.session.id !== (request.params as { id: string }).id) throw Object.assign(new Error('Session is not active'), { statusCode: 409, code: 'SESSION_NOT_ACTIVE' });
    if (state.session.isUserTurn) break;
    const player = chooseSimulatedPlayer({ players: state.players, picks: state.picks, overallPick: state.session.currentOverallPick, teamCount: state.session.teamCount, seed: parsed.body.seed });
    await browser.ingestSyntheticPick({ dedupeKey: `${parsed.commandId}:${state.session.currentOverallPick}`, pick: { overallPick: state.session.currentOverallPick, externalPlayerId: player.id, playerName: player.name, draftingSlot: ((state.session.currentOverallPick - 1) % state.session.teamCount) + 1 } });
    revision = repository.getActiveSession().revision; applied += 1;
  }
  emit('simulator.advance'); return { revision, applied };
});

app.post('/v1/draft-sessions/:id/reset', async (request) => {
  const parsed = ResetCommandSchema.parse(request.body);
  if (browser.health().pageAttached) throw Object.assign(new Error('Stop following the ESPN page before resetting the local board'), { statusCode: 409, code: 'OBSERVATION_ACTIVE' });
  const result = repository.resetSession({ commandId: parsed.commandId, expectedRevision: parsed.expectedRevision, confirmation: parsed.body.confirmation });
  emit('session.reset'); return result;
});

app.post('/v1/operations/:id/undo', async (request) => { const result = repository.undoOperation((request.params as { id: string }).id); emit('operation.undo'); return result; });
app.post('/v1/browser/start', async () => { const result = await browser.start(); emit('browser.start', 'observer.health.changed'); return result; });
app.post('/v1/browser/bind-page', async (request) => { const parsed = BindPageCommandSchema.parse(request.body); const result = await browser.bindPage(parsed.body.pageIndex); emit('browser.bind', 'observer.health.changed'); return result; });
app.get('/v1/browser/tab-bridge', async () => ({ bookmarklet: buildEspnTabBridge(`http://127.0.0.1:${port}/v1/bridge/observe?token=${bridgeToken}`) }));
app.get('/v1/bridge/extension-config', async () => ({ endpoint: `http://127.0.0.1:${port}/v1/bridge/observe?token=${bridgeToken}` }));
app.post('/v1/bridge/observe', async (request) => {
  const payload = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
  const parsed = TabBridgeObservationSchema.parse(payload);
  const result = await browser.ingestTabBridge(parsed);
  emit('tab.bridge.observed', 'observer.health.changed');
  return result;
});
app.post('/v1/draft-sessions/:id/reconcile', async () => { const result = await browser.reconcileNow(); emit('browser.reconcile'); return result; });

app.get('/v1/events', async (request, reply) => {
  reply.hijack();
  const response = reply.raw;
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (event: DomainEvent) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  listeners.add(send);
  const session = repository.getActiveSession();
  response.write(`event: ready\ndata: ${JSON.stringify({ engineInstanceId, aggregateRevision: session.revision })}\n\n`);
  const heartbeat = setInterval(() => response.write(`: keepalive ${Date.now()}\n\n`), 15_000);
  response.on('close', () => { clearInterval(heartbeat); listeners.delete(send); });
});

const shutdown = async () => { await app.close(); repository.close(); process.exit(0); };
process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
await app.listen({ host: '127.0.0.1', port });
app.log.info({ port, dataDirectory, engineInstanceId }, 'engine ready');
