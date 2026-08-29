import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildEspnTabBridge } from '../../apps/engine/src/tab-bridge.ts';

describe('ESPN tab bridge', () => {
  it('posts early round-one picks with the scheduled league size', async () => {
    const pickRows = [
      'Bijan Robinson / ATL RB R1, P1 - Ritz Blitz',
      'Puka Nacua / LAR WR R1, P2 - They Hit the Second Bower',
      "Ja'Marr Chase / CIN WR R1, P3 - Comeback Season",
      'Christian McCaffrey / SF RB R1, P4 - premature eJEANTYlation',
      'James Cook III / BUF RB R1, P5 - L!ck my Josh Strap',
      'Jahmyr Gibbs / DET RB R1, P6 - Hot Buurrrito Guy',
      'Jonathan Taylor / IND RB R1, P7 - Jalen it HURTS',
    ];
    const rendered = `RND 1 OF 16 On the Clock: Pick 8 Round 2 PICK 9 Saquon my Bark ${pickRows.join(' ')}`;
    const attributes = new Map<string, string>();
    let posted: { url: string; init: { body: string } } | undefined;
    let resolvePost!: () => void;
    const postReceived = new Promise<void>((resolve) => { resolvePost = resolve; });
    const element = (innerText: string) => ({ innerText, textContent: innerText, getAttribute: () => null, querySelectorAll: () => [] });
    const bookmarklet = buildEspnTabBridge('http://127.0.0.1:4317/v1/bridge/observe?token=test');
    const pageDocument = {
      body: { innerText: rendered },
      documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
      querySelectorAll: (selector: string) => selector === 'li,div' ? pickRows.map(element) : [],
    };
    const pageLocation = { href: 'https://fantasy.espn.com/football/draft?leagueId=practice-123', pathname: '/football/draft' };
    const pageWindow = { document: pageDocument, location: pageLocation, open: () => null, closed: false };

    runInNewContext(bookmarklet.slice('javascript:'.length), {
      window: pageWindow,
      document: pageDocument,
      location: pageLocation,
      fetch: async (url: string, init: { body: string }) => { posted = { url, init }; resolvePost(); return {}; },
      setInterval: () => 1,
      clearInterval: () => undefined,
      URL,
      console,
    });

    await postReceived;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(posted?.url).toContain('/v1/bridge/observe?token=test');
    const snapshot = JSON.parse(posted!.init.body) as { teamCount: number; rounds: number; picks: Array<{ overallPick: number; playerName: string }> };
    expect(snapshot.teamCount).toBe(8);
    expect(snapshot.rounds).toBe(16);
    expect(snapshot.picks).toHaveLength(7);
    expect(snapshot.picks.at(-1)).toEqual(expect.objectContaining({ overallPick: 7, playerName: 'Jonathan Taylor' }));
    expect(attributes.get('data-fourth-down-bridge')).toBe('active');
  });

  it('follows a same-origin practice popup opened by the stable league page', async () => {
    const pickRows = [
      'Bijan Robinson / ATL RB R1, P1 - Ritz Blitz',
      'Puka Nacua / LAR WR R1, P2 - They Hit the Second Bower',
    ];
    const element = (innerText: string) => ({ innerText, textContent: innerText, getAttribute: () => null, querySelectorAll: () => [] });
    const parentAttributes = new Map<string, string>();
    const parentDocument = {
      body: { innerText: 'Saquon my Bark Clubhouse' },
      documentElement: { setAttribute: (name: string, value: string) => parentAttributes.set(name, value) },
      querySelectorAll: () => [],
    };
    const childDocument = {
      body: { innerText: `RND 1 OF 16 Round 2 PICK 9 ${pickRows.join(' ')}` },
      documentElement: { setAttribute: () => undefined },
      querySelectorAll: (selector: string) => selector === 'li,div' ? pickRows.map(element) : [],
    };
    const childWindow = { document: childDocument, location: { href: 'https://fantasy.espn.com/football/draft?leagueId=popup-456', pathname: '/football/draft' }, closed: false };
    const parentLocation = { href: 'https://fantasy.espn.com/football/team?leagueId=league-123', pathname: '/football/team' };
    const parentWindow = { document: parentDocument, location: parentLocation, open: () => childWindow, closed: false };
    let intervalTick: (() => Promise<void>) | undefined;
    let postedBody = '';
    const bookmarklet = buildEspnTabBridge('http://127.0.0.1:4317/v1/bridge/observe?token=test');

    runInNewContext(bookmarklet.slice('javascript:'.length), {
      window: parentWindow,
      document: parentDocument,
      location: parentLocation,
      fetch: async (_url: string, init: { body: string }) => { postedBody = init.body; return {}; },
      setInterval: (callback: () => Promise<void>) => { intervalTick = callback; return 1; },
      clearInterval: () => undefined,
      URL,
      console,
    });

    parentWindow.open();
    await intervalTick!();
    const snapshot = JSON.parse(postedBody) as { externalDraftId: string; teamCount: number; picks: unknown[] };
    expect(snapshot.externalDraftId).toBe('popup-456');
    expect(snapshot.teamCount).toBe(8);
    expect(snapshot.picks).toHaveLength(2);
    expect(parentAttributes.get('data-fourth-down-bridge')).toBe('active');
  });
});
