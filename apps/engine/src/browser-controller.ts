import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Authority, DraftEnvironment, Health, ObservationPick, RawObservation, TabBridgeObservation } from '@fda/contracts';
import { EspnDraftAdapter, PlaywrightReadonlyPage } from '@fda/espn-adapter';
import type { DraftRepository } from '@fda/db';

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private detach: (() => Promise<void> | void) | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private state: Health['chrome'] = 'stopped';
  private auth: Health['espnAuth'] = 'unknown';
  private detected = false;
  private attached = false;
  private capture: Health['capture'] = 'idle';
  private lastObservationAt: string | null = null;
  private lastReconciledAt: string | null = null;
  private readonly instrumentedPages = new WeakSet<Page>();
  private readonly adapters: Record<DraftEnvironment, EspnDraftAdapter> = {
    PRACTICE: new EspnDraftAdapter(),
    LIVE: new EspnDraftAdapter(),
  };

  constructor(
    private readonly repository: DraftRepository,
    private readonly profileRoot: string,
    private readonly onChanged: (cause: string) => void,
  ) {}

  private get adapter() { return this.adapters[this.repository.getDraftEnvironment()]; }

  health() {
    return {
      chrome: this.state, espnAuth: this.auth, pageDetected: this.detected, pageAttached: this.attached, capture: this.capture,
      lastObservationAt: this.lastObservationAt, lastReconciledAt: this.lastReconciledAt,
    };
  }

  async start() {
    if (this.context) return this.health();
    this.state = 'launching';
    this.onChanged('browser.launching');
    mkdirSync(this.profileRoot, { recursive: true, mode: 0o700 });
    try {
      this.browser = await this.connectToPersistentChrome();
      this.context = this.browser.contexts()[0] ?? null;
      if (!this.context) throw new Error('Persistent Chrome did not expose a browser context');
      this.browser.on('disconnected', () => {
        this.browser = null; this.context = null; this.page = null; this.state = 'disconnected'; this.capture = 'idle'; this.detected = false; this.attached = false;
        this.onChanged('browser.disconnected');
      });
      this.context.on('page', (page) => { void this.considerPage(page); });
      const pages = this.context.pages();
      for (const page of pages) if (await this.considerPage(page)) return this.health();
      const page = pages[0] ?? await this.context.newPage();
      const configuredBase = process.env.FDA_ESPN_BASE_URL;
      const baseUrl = configuredBase && /^https:\/\/fantasy\.espn\.com\/football\//i.test(configuredBase)
        ? configuredBase
        : 'https://fantasy.espn.com/football/welcome';
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      await this.considerPage(page);
      return this.health();
    } catch (error) {
      this.state = 'disconnected'; this.onChanged('browser.launch.failed'); throw error;
    }
  }

  private async connectToPersistentChrome(): Promise<Browser> {
    const port = Number(process.env.FDA_CHROME_DEBUG_PORT ?? 9327);
    const endpoint = `http://127.0.0.1:${port}`;
    const existing = await chromium.connectOverCDP(endpoint).catch(() => null);
    if (existing) return existing;
    const executable = process.env.FDA_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const child = spawn(executable, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profileRoot}`,
      '--no-first-run',
      '--disable-default-apps',
      '--remote-allow-origins=http://127.0.0.1',
    ], { detached: true, stdio: 'ignore' });
    child.unref();
    let lastError: unknown;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      try { return await chromium.connectOverCDP(endpoint); } catch (error) { lastError = error; }
    }
    throw new Error(`Could not attach to persistent Chrome: ${lastError instanceof Error ? lastError.message : 'connection timed out'}`);
  }

  private async considerPage(page: Page, explicitBind = false): Promise<boolean> {
    const readonly = new PlaywrightReadonlyPage(page);
    const identity = await this.adapter.identifyPage(readonly).catch(() => null);
    if (!identity?.matches) return false;
    this.page = page;
    this.auth = identity.authenticated ? 'authenticated' : 'required';
    this.detected = identity.pageKind === 'draft';
    if (explicitBind && this.detected) this.repository.activateObservedSession({ externalDraftId: identity.externalDraftId, name: 'ESPN observed draft' });
    const session = this.repository.getActiveSession();
    const sameExternalDraft = !session.external_draft_id || !identity.externalDraftId || session.external_draft_id === identity.externalDraftId;
    this.attached = this.detected && session.external_platform === 'espn' && sameExternalDraft;
    this.state = identity.authenticated ? (this.attached ? 'observing' : 'ready') : 'login_required';
    this.capture = this.attached ? 'healthy' : 'idle';
    await this.detach?.();
    this.detach = this.attached ? await this.adapter.attachPassiveCapture(readonly, (observation) => this.handleObservation(observation)) : null;
    if (!this.instrumentedPages.has(page)) {
      this.instrumentedPages.add(page);
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) setTimeout(() => void this.considerPage(page), 500);
      });
    }
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.snapshotTimer = setInterval(() => { if (this.attached) void this.reconcileNow(); }, 5_000);
    this.snapshotTimer.unref();
    this.onChanged('browser.page.changed');
    if (this.attached) await this.reconcileNow();
    return true;
  }

  async bindPage(pageIndex?: number) {
    if (!this.context) throw Object.assign(new Error('Chrome is not running'), { statusCode: 409, code: 'CHROME_STOPPED' });
    const pages = this.context.pages();
    const candidates: Array<{ index: number; url: string; title: string }> = [];
    for (let index = 0; index < pages.length; index += 1) {
      const readonly = new PlaywrightReadonlyPage(pages[index]!);
      const identity = await this.adapter.identifyPage(readonly);
      if (identity.matches) candidates.push({ index, url: pages[index]!.url(), title: await pages[index]!.title() });
    }
    if (pageIndex === undefined && candidates.length !== 1) return { requiresSelection: true, candidates };
    const selected = pages[pageIndex ?? candidates[0]!.index];
    if (!selected || !(await this.considerPage(selected, true))) throw Object.assign(new Error('Selected page is not a supported ESPN fantasy page'), { statusCode: 422, code: 'PAGE_NOT_SUPPORTED' });
    return { requiresSelection: false, candidates, health: this.health() };
  }

  async refreshEnvironment() {
    if (this.page) await this.considerPage(this.page);
    this.onChanged('draft.environment.changed');
    return this.health();
  }

  async ingestSyntheticPick(input: { dedupeKey: string; pick: ObservationPick }) {
    const observation: RawObservation = {
      mechanism: 'structured', kind: 'incremental', adapterSchemaVersion: 'practice-simulator-v1',
      externalDraftId: 'practice-simulator', observedAt: new Date().toISOString(), dedupeKey: input.dedupeKey,
      payload: { picks: [input.pick] },
    };
    await this.handleObservation(observation, 'simulator');
    return this.health();
  }

  async reconcileNow() {
    if (!this.page && this.attached) return this.health();
    if (!this.page) throw Object.assign(new Error('No ESPN page is attached'), { statusCode: 409, code: 'PAGE_NOT_ATTACHED' });
    const observation = await this.adapter.captureRenderedSnapshot(new PlaywrightReadonlyPage(this.page));
    await this.handleObservation(observation);
    return this.health();
  }

  async ingestTabBridge(input: TabBridgeObservation) {
    if (input.picks.length === 0) return this.health();
    this.repository.activateObservedSession({
      externalDraftId: input.externalDraftId, name: 'ESPN observed draft', teamCount: input.teamCount,
      rounds: input.rounds, userSlot: input.userSlot ? Math.min(input.userSlot, input.teamCount) : undefined, replace: true,
    });
    this.auth = 'authenticated'; this.detected = true; this.attached = true; this.state = 'observing'; this.capture = 'healthy';
    const facts = { picks: input.picks, players: input.players };
    const digest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    await this.handleObservation({
      mechanism: 'structured', kind: 'full_snapshot', adapterSchemaVersion: 'espn-tab-bridge-v2',
      externalDraftId: input.externalDraftId, observedAt: input.observedAt,
      dedupeKey: `tab-bridge:v2:${input.externalDraftId}:${digest}`, payload: facts,
    });
    this.onChanged('tab.bridge.observed');
    return this.health();
  }

  private async handleObservation(observation: RawObservation, authorityOverride?: Authority) {
    const session = this.repository.getActiveSession();
    const normalized = this.adapter.normalize(observation);
    const recorded = this.repository.recordObservation({
      sessionId: session.id, mechanism: observation.mechanism, kind: observation.kind,
      adapterSchemaVersion: observation.adapterSchemaVersion, externalDraftId: observation.externalDraftId,
      dedupeKey: observation.dedupeKey, payload: normalized.observation.payload, parseStatus: normalized.picks.length || normalized.players.length ? 'NORMALIZED' : 'QUARANTINED',
    });
    this.lastObservationAt = recorded.observedAt;
    this.repository.upsertObservedPlayers(normalized.players);
    let currentRevision = this.repository.getActiveSession().revision;
    const persisted = new Map(this.repository.listPicks(session.id).map((pick) => [pick.overallPick, pick.playerId]));
    const applied: ObservationPick[] = [];
    let confirmed = 0;
    for (const pick of normalized.picks.sort((a, b) => a.overallPick - b.overallPick)) {
      const player = this.repository.resolvePlayer({ source: 'espn', externalId: pick.externalPlayerId, name: pick.playerName });
      if (!player) continue;
      if (persisted.get(pick.overallPick) === player.id) { confirmed += 1; continue; }
      const result = this.repository.applyPick({
        commandId: `${observation.dedupeKey}:${pick.overallPick}`.slice(0, 128), expectedRevision: currentRevision,
        playerId: player.id, overallPick: pick.overallPick,
        authority: authorityOverride ?? (observation.mechanism === 'structured' || observation.mechanism === 'websocket' ? 'structured' : 'dom'),
        reason: `Observed through ${observation.mechanism}`,
      }) as { revision: number; conflict?: boolean };
      currentRevision = result.revision;
      if (!result.conflict) applied.push(pick);
    }
    const fullyConfirmed = normalized.picks.length > 0 && confirmed === normalized.picks.length;
    if (applied.length || fullyConfirmed) this.lastReconciledAt = new Date().toISOString();
    this.onChanged(applied.length || fullyConfirmed ? 'espn.reconciled' : 'espn.observed');
  }
}
