import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('Fourth Down Chrome extension', () => {
  it('rotates the draft run on same-tab navigation but preserves it on refresh', () => {
    const source = readFileSync(new URL('../../apps/chrome-extension/content.js', import.meta.url), 'utf8');
    const execute = (navigationType: 'navigate' | 'reload') => {
      const stored = new Map([['fourth-down-draft-run-id', 'prior-run']]);
      runInNewContext(source, {
        window: {}, document: { body: { innerText: '' }, documentElement: { setAttribute: () => undefined }, querySelectorAll: () => [] },
        location: { href: 'https://fantasy.espn.com/football/team?leagueId=extension-789', pathname: '/football/team' },
        sessionStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) },
        performance: { getEntriesByType: () => [{ type: navigationType }] },
        crypto: { randomUUID: () => 'next-run' },
        chrome: { runtime: { sendMessage: async () => ({ ok: true }) } },
        setInterval: () => 1, clearInterval: () => undefined, URL, Date, console,
      });
      return stored.get('fourth-down-draft-run-id');
    };
    expect(execute('navigate')).toBe('next-run');
    expect(execute('reload')).toBe('prior-run');
  });

  it('serializes tab claims so concurrent draft tabs cannot both win the lease', async () => {
    const source = readFileSync(new URL('../../apps/chrome-extension/service-worker.js', import.meta.url), 'utf8');
    let listener!: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean;
    let lease: unknown;
    runInNewContext(source, {
      self: { FOURTH_DOWN_PAIRING_TOKEN: 'test-pairing-token' },
      importScripts: () => undefined,
      chrome: {
        storage: { session: {
          get: async () => ({ draftTabLease: lease }),
          set: async (value: { draftTabLease: unknown }) => { lease = value.draftTabLease; },
        } },
        runtime: { onMessage: { addListener: (value: typeof listener) => { listener = value; } } },
      },
      fetch: async () => ({ ok: true }),
      Date,
      Promise,
      Error,
    });
    const observe = (tabId: number) => new Promise<unknown>((resolve) => {
      expect(listener({ type: 'FOURTH_DOWN_OBSERVATION', snapshot: { externalDraftId: `draft-${tabId}` } }, { tab: { id: tabId } }, resolve)).toBe(true);
    });
    const [first, second] = await Promise.all([observe(11), observe(22)]);
    expect(first).toEqual({ ok: true });
    expect(second).toMatchObject({ ok: false });
  });

  it('normalizes rendered ESPN picks and sends them through extension messaging', async () => {
    const pickRows = [
      'Bijan Robinson / ATL RB R1, P1 - Ritz Blitz',
      'Puka Nacua / LAR WR R1, P2 - They Hit the Second Bower',
    ];
    const rendered = `RND 1 OF 16 Round 2 PICK 9 ${pickRows.join(' ')}
Roster
QB J. Burrow
RB T. Etienne Jr.
RB C. Skattebo
WR A. St. Brown
WR C. Lamb
TE K. Pitts Sr.
FLEX R. Rice
FLEX G. Pickens
D/ST Texans D/ST
K B. Aubrey
BE J. Warren
BE T. Henderson
BE T. Kraft
BE T. Lawrence
BE J. Downs
BE J. Ferguson
Roster Limits
16/16 Players
QB 2/4 RB 4/8 WR 5/8 TE 3/3 K 1/3 D/ST 1/3`;
    const attributes = new Map<string, string>();
    const element = (innerText: string) => ({ innerText, textContent: innerText, querySelectorAll: () => [] });
    let sentMessage: { type: string; snapshot: { externalDraftId: string; teamCount: number; picks: Array<{ playerName: string }>; leagueSettings?: { roster: { FLEX: number; BENCH: number }; positionLimits: { QB: number; RB: number; WR: number; TE: number; K: number; DST: number } } } } | undefined;
    let resolveMessage!: () => void;
    const messageSent = new Promise<void>((resolve) => { resolveMessage = resolve; });
    const source = readFileSync(new URL('../../apps/chrome-extension/content.js', import.meta.url), 'utf8');

    runInNewContext(source, {
      window: {},
      document: {
        body: { innerText: rendered },
        documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
        querySelectorAll: (selector: string) => selector === 'li,div' ? pickRows.map(element) : [],
      },
      location: { href: 'https://fantasy.espn.com/football/draft?leagueId=extension-789', pathname: '/football/draft' },
      chrome: {
        runtime: {
          sendMessage: async (message: typeof sentMessage) => { sentMessage = message; resolveMessage(); return { ok: true }; },
        },
      },
      setInterval: () => 1,
      clearInterval: () => undefined,
      URL,
      Date,
      console,
    });

    await messageSent;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentMessage?.type).toBe('FOURTH_DOWN_OBSERVATION');
    expect(sentMessage?.snapshot.externalDraftId).toMatch(/^extension-789:run:page-/);
    expect(sentMessage?.snapshot.teamCount).toBe(8);
    expect(sentMessage?.snapshot.picks.map((pick) => pick.playerName)).toEqual(['Bijan Robinson', 'Puka Nacua']);
    expect(sentMessage?.snapshot.leagueSettings?.roster).toEqual(expect.objectContaining({ QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 2, K: 1, DST: 1, BENCH: 6 }));
    expect(sentMessage?.snapshot.leagueSettings?.positionLimits).toEqual({ QB: 4, RB: 8, WR: 8, TE: 3, K: 3, DST: 3 });
    expect(attributes.get('data-fourth-down-extension')).toBe('active');
  });
});
