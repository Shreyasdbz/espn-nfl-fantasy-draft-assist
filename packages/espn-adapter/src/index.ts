import { createHash } from 'node:crypto';
import type { Page, Response, WebSocket } from 'playwright';
import type {
  AdapterHealth, Detach, DraftPlatformAdapter, NormalizedObservation, ObservationSink,
  PageIdentityResult, ReadonlyPage, ReadonlyResponse, ReadonlyWebSocket,
} from '@fda/adapter-sdk';
import type { ObservationPick, ObservationPlayer, Position, RawObservation } from '@fda/contracts';

const SCHEMA_VERSION = 'espn-readonly-v1';
const ESPN_HOST = /(^|\.)espn\.com$/i;
const DRAFT_URL = /fantasy\.espn\.com\/football\/(draft|league\/draft)(?:[/?#]|$)/i;
const RELEVANT_URL = /(draft|pick|fantasy|league)/i;
const POSITION_IDS: Record<string, Position> = { '1': 'QB', '2': 'RB', '3': 'WR', '4': 'TE', '5': 'K', '16': 'DST', QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DST: 'DST', D_ST: 'DST' };
const PRO_TEAM_IDS: Record<string, string> = {
  '1': 'ATL', '2': 'BUF', '3': 'CHI', '4': 'CIN', '5': 'CLE', '6': 'DAL', '7': 'DEN', '8': 'DET', '9': 'GB', '10': 'TEN',
  '11': 'IND', '12': 'KC', '13': 'LV', '14': 'LAR', '15': 'MIA', '16': 'MIN', '17': 'NE', '18': 'NO', '19': 'NYG', '20': 'NYJ',
  '21': 'PHI', '22': 'ARI', '23': 'PIT', '24': 'LAC', '25': 'SF', '26': 'SEA', '27': 'TB', '28': 'WAS', '29': 'CAR', '30': 'JAX',
  '33': 'BAL', '34': 'HOU', '0': 'FA',
};

function hashPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function externalDraftId(urlValue: string): string | undefined {
  try {
    const url = new URL(urlValue);
    return url.searchParams.get('draftId') ?? url.searchParams.get('leagueId') ?? undefined;
  } catch {
    return undefined;
  }
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function extractPicks(value: unknown, found: ObservationPick[] = [], depth = 0): ObservationPick[] {
  if (depth > 10 || found.length > 300 || value === null) return found;
  if (Array.isArray(value)) {
    for (const item of value) extractPicks(item, found, depth + 1);
    return found;
  }
  if (typeof value !== 'object') return found;
  const object = value as Record<string, unknown>;
  const pickValue = object.overallPickNumber ?? object.overallPick ?? object.pickNumber ?? object.overall;
  const playerObject = (object.player ?? object.athlete ?? object.proPlayer ?? {}) as Record<string, unknown>;
  const playerId = object.externalPlayerId ?? object.playerId ?? object.athleteId ?? playerObject.id;
  const playerName = object.playerName ?? object.athleteName ?? playerObject.fullName ?? playerObject.name;
  const slot = object.draftingSlot ?? object.teamSlot ?? object.memberIndex;
  if (typeof pickValue === 'number' && pickValue > 0 && (typeof playerId === 'string' || typeof playerId === 'number' || typeof playerName === 'string')) {
    found.push({
      overallPick: Math.trunc(pickValue),
      externalPlayerId: playerId === undefined ? undefined : String(playerId),
      playerName: typeof playerName === 'string' ? cleanText(playerName) : undefined,
      draftingSlot: typeof slot === 'number' ? Math.trunc(slot) : undefined,
    });
  }
  for (const [key, child] of Object.entries(object)) {
    if (/(cookie|token|auth|email|chat|message|header)/i.test(key)) continue;
    extractPicks(child, found, depth + 1);
  }
  return found;
}

function uniquePicks(picks: ObservationPick[]): ObservationPick[] {
  const byPick = new Map<number, ObservationPick>();
  for (const pick of picks.sort((a, b) => a.overallPick - b.overallPick)) {
    if (!byPick.has(pick.overallPick)) byPick.set(pick.overallPick, pick);
  }
  return [...byPick.values()];
}

function finiteNumber(...values: unknown[]): number | null {
  for (const value of values) if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function asObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function extractPlayers(value: unknown, found: ObservationPlayer[] = [], depth = 0): ObservationPlayer[] {
  if (depth > 10 || found.length > 2_000 || value === null) return found;
  if (Array.isArray(value)) { for (const item of value) extractPlayers(item, found, depth + 1); return found; }
  if (typeof value !== 'object') return found;
  const object = value as Record<string, unknown>;
  const nested = asObject(object.player ?? object.athlete ?? object.proPlayer);
  const candidate = Object.keys(nested).length ? nested : object;
  const externalId = object.externalPlayerId ?? candidate.id ?? object.playerId ?? object.athleteId;
  const playerName = candidate.fullName ?? candidate.name ?? object.playerName ?? object.athleteName;
  const rawPosition = candidate.defaultPositionId ?? candidate.positionId ?? candidate.position ?? object.position;
  const position = rawPosition === undefined ? undefined : POSITION_IDS[String(rawPosition).toUpperCase().replace(/[^A-Z0-9]/g, '_')];
  if ((typeof externalId === 'string' || typeof externalId === 'number') && typeof playerName === 'string' && position) {
    const ownership = asObject(object.ownership ?? candidate.ownership);
    const rankings = asObject(candidate.draftRanksByRankType ?? object.draftRanksByRankType);
    const ppr = asObject(rankings.PPR ?? rankings.STANDARD ?? rankings.default);
    const ratings = Array.isArray(candidate.ratings) ? candidate.ratings.map(asObject) : [];
    const stats = Array.isArray(candidate.stats) ? candidate.stats.map(asObject) : Array.isArray(object.stats) ? object.stats.map(asObject) : [];
    const projected = finiteNumber(object.projection, candidate.projection)
      ?? stats.filter((stat) => stat.statSourceId === 1 || stat.sourceId === 1).map((stat) => finiteNumber(stat.appliedTotal, stat.total, stat.projectedPoints)).filter((number): number is number => number !== null).sort((a, b) => b - a)[0]
      ?? null;
    const rawTeam = candidate.proTeamId ?? candidate.teamId ?? candidate.teamAbbrev ?? object.proTeamId ?? object.team;
    const team = rawTeam === undefined || rawTeam === null ? null : PRO_TEAM_IDS[String(rawTeam)] ?? cleanText(String(rawTeam)).toUpperCase().slice(0, 4);
    found.push({
      externalPlayerId: String(externalId), playerName: cleanText(playerName), position, team: team === 'FA' ? null : team,
      adp: finiteNumber(ownership.averageDraftPosition, object.averageDraftPosition, object.adp), projection: projected,
      overallRank: finiteNumber(ppr.rank, object.overallRank, object.rank),
      positionalRank: finiteNumber(ratings[0]?.positionalRanking, ppr.positionalRanking, object.positionalRank),
    });
  }
  for (const [key, child] of Object.entries(object)) {
    if (/(cookie|token|auth|email|chat|message|header)/i.test(key)) continue;
    extractPlayers(child, found, depth + 1);
  }
  return found;
}

function uniquePlayers(players: ObservationPlayer[]): ObservationPlayer[] {
  const byId = new Map<string, ObservationPlayer>();
  for (const player of players) {
    const current = byId.get(player.externalPlayerId);
    const richness = (candidate: ObservationPlayer) => [candidate.adp, candidate.projection, candidate.overallRank, candidate.positionalRank, candidate.team].filter((value) => value !== null).length;
    if (!current || richness(player) > richness(current)) byId.set(player.externalPlayerId, player);
  }
  return [...byId.values()];
}

class PlaywrightReadonlyResponse implements ReadonlyResponse {
  constructor(private readonly response: Response) {}
  url() { return this.response.url(); }
  status() { return this.response.status(); }
  contentType() { return this.response.headerValue('content-type'); }
  async json(maxBytes: number): Promise<unknown | null> {
    const contentType = await this.contentType();
    if (!contentType?.includes('json')) return null;
    const buffer = await this.response.body().catch(() => null);
    if (!buffer || buffer.byteLength > maxBytes) return null;
    try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
  }
}

class PlaywrightReadonlyWebSocket implements ReadonlyWebSocket {
  constructor(private readonly socket: WebSocket) {}
  url() { return this.socket.url(); }
  onFrame(listener: (payload: string) => void) {
    this.socket.on('framereceived', (event) => {
      if (typeof event.payload === 'string' && event.payload.length <= 1_000_000) listener(event.payload);
    });
  }
}

export class PlaywrightReadonlyPage implements ReadonlyPage {
  constructor(private readonly page: Page) {}
  url() { return this.page.url(); }
  title() { return this.page.title(); }
  async text(selector: string, limit = 250): Promise<string[]> {
    return (await this.page.locator(selector).allTextContents()).slice(0, limit).map(cleanText).filter(Boolean);
  }
  async exists(selector: string): Promise<boolean> { return await this.page.locator(selector).count() > 0; }
  onResponse(listener: (response: ReadonlyResponse) => void) { this.page.on('response', (response) => listener(new PlaywrightReadonlyResponse(response))); }
  onWebSocket(listener: (socket: ReadonlyWebSocket) => void) { this.page.on('websocket', (socket) => listener(new PlaywrightReadonlyWebSocket(socket))); }
  onNavigation(listener: () => void) { this.page.on('framenavigated', (frame) => { if (frame === this.page.mainFrame()) listener(); }); }
}

export class EspnDraftAdapter implements DraftPlatformAdapter {
  readonly key = 'espn';

  async identifyPage(page: ReadonlyPage): Promise<PageIdentityResult> {
    const urlValue = page.url();
    let parsed: URL | null = null;
    try { parsed = new URL(urlValue); } catch { /* about:blank */ }
    const title = await page.title().catch(() => '');
    const accountControls = await page.text('a[href*="login"], a[href*="signin"], a[href*="welcome"], button', 100).catch(() => []);
    const accountDialog = await page.exists('iframe[src*="registerdisney"], iframe[src*="disneyid"], input[type="email"]').catch(() => false);
    const authenticatedMarker = await page.exists('a[href*="/football/team?leagueId="], a[href*="/football/league?leagueId="]').catch(() => false);
    const login = parsed?.hostname.includes('registerdisney') || accountDialog || /log in|sign in/i.test(title)
      || (!authenticatedMarker && accountControls.some((text) => /\b(log in|sign in|sign up)\b/i.test(text)));
    if (login) return { matches: true, authenticated: false, pageKind: 'login' };
    const espn = !!parsed && ESPN_HOST.test(parsed.hostname);
    const stagingPage = !!parsed && /\/(mockdraftlobby|waitingroom|editdraftstrategy|welcome)(?:[/?#]|$)/i.test(parsed.pathname);
    const draft = !stagingPage && (DRAFT_URL.test(urlValue) || /\bdraft(?:ing)?\b/i.test(title));
    return {
      matches: espn && (draft || parsed?.hostname === 'fantasy.espn.com'),
      authenticated: espn && !login,
      externalDraftId: externalDraftId(urlValue),
      pageKind: draft ? 'draft' : espn ? 'league' : 'other',
    };
  }

  async attachPassiveCapture(page: ReadonlyPage, sink: ObservationSink): Promise<Detach> {
    let detached = false;
    page.onResponse(async (response) => {
      if (detached || response.status() >= 400 || !RELEVANT_URL.test(response.url())) return;
      const payload = await response.json(2_000_000).catch(() => null);
      if (!payload) return;
      const picks = uniquePicks(extractPicks(payload));
      const players = uniquePlayers(extractPlayers(payload));
      if (!picks.length && !players.length) return;
      const sanitized = { picks, players };
      await sink({
        mechanism: 'structured', kind: picks.length > 1 ? 'full_snapshot' : 'incremental', adapterSchemaVersion: SCHEMA_VERSION,
        externalDraftId: externalDraftId(page.url()), observedAt: new Date().toISOString(),
        dedupeKey: `response:${hashPayload(sanitized)}`, payload: sanitized,
      });
    });
    page.onWebSocket((socket) => {
      if (!RELEVANT_URL.test(socket.url())) return;
      socket.onFrame(async (frame) => {
        if (detached) return;
        let parsed: unknown;
        try { parsed = JSON.parse(frame); } catch { return; }
        const picks = uniquePicks(extractPicks(parsed));
        const players = uniquePlayers(extractPlayers(parsed));
        if (!picks.length && !players.length) return;
        const sanitized = { picks, players };
        await sink({
          mechanism: 'websocket', kind: picks.length > 1 ? 'full_snapshot' : 'incremental', adapterSchemaVersion: SCHEMA_VERSION,
          externalDraftId: externalDraftId(page.url()), observedAt: new Date().toISOString(),
          dedupeKey: `websocket:${hashPayload(sanitized)}`, payload: sanitized,
        });
      });
    });
    return () => { detached = true; };
  }

  async captureRenderedSnapshot(page: ReadonlyPage): Promise<RawObservation> {
    const selectors = [
      '[data-testid*="pick"]', '[data-testid*="draft"] [role="row"]',
      '[class*="draft"] [class*="pick"]', '[class*="Draft"] [class*="Pick"]',
    ];
    const rows: string[] = [];
    for (const selector of selectors) {
      const text = await page.text(selector, 250).catch(() => []);
      for (const row of text) if (row && !rows.includes(row)) rows.push(row);
    }
    const sanitized = { rows: rows.slice(0, 250) };
    return {
      mechanism: 'dom', kind: 'full_snapshot', adapterSchemaVersion: SCHEMA_VERSION,
      externalDraftId: externalDraftId(page.url()), observedAt: new Date().toISOString(),
      dedupeKey: `dom:${hashPayload(sanitized)}`, payload: sanitized,
    };
  }

  normalize(observation: RawObservation): NormalizedObservation {
    const payload = observation.payload as { picks?: unknown };
    const picks = uniquePicks(extractPicks(payload?.picks ?? payload));
    const players = uniquePlayers(extractPlayers(payload));
    if (picks.length || players.length) return { observation: { ...observation, payload: { picks, players } }, picks, players, confidence: observation.mechanism === 'dom' ? 'medium' : 'high', errors: [] };
    if ((payload as { rows?: unknown }).rows && Array.isArray((payload as { rows?: unknown }).rows)) {
      const rows = (payload as { rows: unknown[] }).rows.filter((row): row is string => typeof row === 'string').slice(0, 250).map(cleanText);
      return { observation: { ...observation, payload: { rows } }, picks: [], players: [], confidence: 'low', errors: ['DOM rows captured but no versioned parser matched them'] };
    }
    return { observation: { ...observation, payload: {} }, picks: [], players: [], confidence: 'low', errors: ['No draft pick or player facts found'] };
  }

  async health(page: ReadonlyPage): Promise<AdapterHealth> {
    const identity = await this.identifyPage(page);
    return {
      compatible: identity.matches,
      authenticated: identity.authenticated,
      pageAttached: identity.pageKind === 'draft',
      captureHealthy: identity.pageKind === 'draft' && identity.authenticated,
      reason: identity.matches ? undefined : 'No supported ESPN fantasy page is open',
    };
  }
}

export const espnAdapterSchemaVersion = SCHEMA_VERSION;
