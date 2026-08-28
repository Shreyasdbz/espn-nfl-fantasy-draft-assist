import { describe, expect, it } from 'vitest';
import { EspnDraftAdapter } from '@fda/espn-adapter';
import type { ReadonlyPage } from '../../packages/adapter-sdk/src/index.ts';

function readonlyPage(input: { url: string; title?: string; controls?: string[]; accountDialog?: boolean; authenticatedMarker?: boolean }): ReadonlyPage {
  return {
    url: () => input.url,
    title: async () => input.title ?? '',
    text: async () => input.controls ?? [],
    exists: async (selector) => selector.includes('registerdisney') ? input.accountDialog ?? false : input.authenticatedMarker ?? false,
    onResponse: () => undefined,
    onWebSocket: () => undefined,
    onNavigation: () => undefined,
  };
}

describe('sanitized ESPN replay contract', () => {
  it('normalizes only pick facts and keeps credentials out of the normalized result', () => {
    const adapter = new EspnDraftAdapter();
    const normalized = adapter.normalize({
      mechanism: 'structured', kind: 'full_snapshot', adapterSchemaVersion: 'espn-readonly-v1',
      externalDraftId: 'fixture-draft', observedAt: '2026-08-27T12:00:00.000Z', dedupeKey: 'fixture-1',
      payload: { picks: [{ overallPickNumber: 1, playerId: 'p-1', playerName: 'Marcus Vale', draftingSlot: 1 }], token: 'must-not-survive' },
    });
    expect(normalized.picks).toEqual([{ overallPick: 1, externalPlayerId: 'p-1', playerName: 'Marcus Vale', draftingSlot: 1 }]);
    expect(JSON.stringify(normalized)).not.toContain('must-not-survive');
  });

  it('quarantines unmatched DOM text instead of guessing', () => {
    const adapter = new EspnDraftAdapter();
    const normalized = adapter.normalize({ mechanism: 'dom', kind: 'full_snapshot', adapterSchemaVersion: 'espn-readonly-v1', observedAt: '2026-08-27T12:00:00.000Z', dedupeKey: 'fixture-2', payload: { rows: ['A changed page row'] } });
    expect(normalized.picks).toEqual([]);
    expect(normalized.confidence).toBe('low');
    expect(normalized.errors[0]).toMatch(/no versioned parser/i);
  });

  it('does not report authenticated while ESPN exposes sign-up or the MyDisney dialog', async () => {
    const adapter = new EspnDraftAdapter();
    const signedOutWelcome = await adapter.identifyPage(readonlyPage({ url: 'https://fantasy.espn.com/football/welcome', controls: ['Sign Up'] }));
    const accountDialog = await adapter.identifyPage(readonlyPage({ url: 'https://fantasy.espn.com/football/waitingroom?leagueId=1', accountDialog: true }));
    expect(signedOutWelcome.authenticated).toBe(false);
    expect(accountDialog.authenticated).toBe(false);
  });

  it('prefers an ESPN team marker over the generic sign-up navigation link', async () => {
    const adapter = new EspnDraftAdapter();
    const signedIn = await adapter.identifyPage(readonlyPage({
      url: 'https://fantasy.espn.com/football/welcome', controls: ['Sign Up'], authenticatedMarker: true,
    }));
    expect(signedIn.authenticated).toBe(true);
    expect(signedIn.pageKind).toBe('league');
  });

  it('does not classify ESPN lobby and waiting-room staging pages as draft boards', async () => {
    const adapter = new EspnDraftAdapter();
    const lobby = await adapter.identifyPage(readonlyPage({ url: 'https://fantasy.espn.com/football/mockdraftlobby', authenticatedMarker: true, title: 'Fantasy Football Mock Draft - ESPN' }));
    const waiting = await adapter.identifyPage(readonlyPage({ url: 'https://fantasy.espn.com/football/waitingroom?leagueId=531200672', authenticatedMarker: true, title: 'Waiting Room - Mock Draft' }));
    expect(lobby.pageKind).toBe('league');
    expect(waiting.pageKind).toBe('league');
  });

  it('normalizes an ESPN player catalog without retaining the surrounding response', () => {
    const adapter = new EspnDraftAdapter();
    const normalized = adapter.normalize({
      mechanism: 'structured', kind: 'full_snapshot', adapterSchemaVersion: 'espn-readonly-v1',
      observedAt: '2026-08-27T12:00:00.000Z', dedupeKey: 'players-1',
      payload: { players: [{ ownership: { averageDraftPosition: 7.2 }, player: { id: 123, fullName: 'Observed Runner', defaultPositionId: 2, proTeamId: 2, draftRanksByRankType: { PPR: { rank: 5 } }, ratings: [{ positionalRanking: 3 }], stats: [{ statSourceId: 1, appliedTotal: 261.4 }] } }], token: 'discard-me' },
    });
    expect(normalized.players).toEqual([{ externalPlayerId: '123', playerName: 'Observed Runner', position: 'RB', team: 'BUF', adp: 7.2, projection: 261.4, overallRank: 5, positionalRank: 3 }]);
    expect(JSON.stringify(normalized.observation.payload)).not.toContain('discard-me');
  });

  it('preserves already-sanitized tab-bridge player identities and projections', () => {
    const adapter = new EspnDraftAdapter();
    const normalized = adapter.normalize({
      mechanism: 'structured', kind: 'full_snapshot', adapterSchemaVersion: 'espn-tab-bridge-v1',
      observedAt: '2026-08-27T12:00:00.000Z', dedupeKey: 'bridge-1',
      payload: {
        picks: [{ overallPick: 8, externalPlayerId: 'dom:christian-mccaffrey', playerName: 'Christian McCaffrey' }],
        players: [{ externalPlayerId: 'dom:christian-mccaffrey', playerName: 'Christian McCaffrey', position: 'RB', team: 'SF', adp: 7, projection: 342.8, overallRank: 7, positionalRank: 7 }],
      },
    });
    expect(normalized.picks[0]?.externalPlayerId).toBe('dom:christian-mccaffrey');
    expect(normalized.players[0]).toMatchObject({ externalPlayerId: 'dom:christian-mccaffrey', projection: 342.8 });
  });
});
