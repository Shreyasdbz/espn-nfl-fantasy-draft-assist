import { mkdirSync } from 'node:fs';
import { chromium } from '../apps/engine/node_modules/playwright/index.mjs';
import type { DraftPick, DraftState } from '../packages/contracts/src/index.ts';
import { analyzeRecommendationContext, recommendPlayers } from '../packages/recommendation/src/index.ts';

const origin = process.env.FDA_WEB_ORIGIN ?? 'http://127.0.0.1:3000';
const outputDirectory = process.env.FDA_RED_TEAM_VISUAL_DIR ?? '/tmp/fourth-down-red-team';
mkdirSync(outputDirectory, { recursive: true });

const response = await fetch(`${origin}/api/engine/v1/state`, { signal: AbortSignal.timeout(5_000) });
if (!response.ok) throw new Error(`Could not read baseline state: ${response.status}`);
const baseline = await response.json() as DraftState;

const rosterRules = baseline.recommendationContext.rosterRules;
const positionLimits = baseline.recommendationContext.positionLimits;
const turnPicks = [8, 9, 24, 25, 40, 41, 56, 57, 72, 73, 88, 89, 104, 105, 120, 121];

function rebuild(input: {
  name: string;
  picks: DraftPick[];
  currentOverallPick: number;
  nextUserPick: number | null;
  attached?: boolean;
  stale?: boolean;
}): DraftState {
  const now = Date.now();
  const timestamp = new Date(now - (input.stale ? 120_000 : 1_000)).toISOString();
  const drafted = new Set(input.picks.map((pick) => pick.playerId));
  const context = analyzeRecommendationContext({
    players: baseline.players, picks: input.picks, userSlot: 8, teamCount: 8,
    currentOverallPick: input.currentOverallPick, nextUserPick: input.nextUserPick,
    rosterRules, positionLimits,
  });
  return {
    ...baseline,
    session: {
      ...baseline.session, id: `red-team-${input.name}`, revision: input.picks.length,
      currentOverallPick: input.currentOverallPick, currentRound: Math.ceil(input.currentOverallPick / 8),
      nextUserPick: input.nextUserPick, isUserTurn: input.nextUserPick === input.currentOverallPick,
    },
    picks: input.picks,
    players: baseline.players.map((player) => ({ ...player, drafted: drafted.has(player.id) })),
    recommendations: recommendPlayers({
      players: baseline.players, picks: input.picks, userSlot: 8, teamCount: 8,
      currentOverallPick: input.currentOverallPick, nextUserPick: input.nextUserPick,
      rosterRules, positionLimits,
    }),
    recommendationContext: context,
    roster: input.picks.filter((pick) => pick.draftingSlot === 8),
    conflicts: [], lastOperation: null,
    health: {
      ...baseline.health, chrome: input.attached ? 'observing' : 'stopped', espnAuth: input.attached ? 'authenticated' : 'unknown',
      pageDetected: input.attached ?? false, pageAttached: input.attached ?? false,
      capture: input.attached ? 'healthy' : 'idle', lastObservationAt: input.attached ? timestamp : null,
      lastReconciledAt: input.attached ? timestamp : null,
    },
  };
}

const userRosterWithoutDst = baseline.roster.filter((pick) => pick.position !== 'DST').map((pick, index): DraftPick => {
  const overallPick = turnPicks[index]!;
  const round = Math.ceil(overallPick / 8);
  const pickInRound = ((overallPick - 1) % 8) + 1;
  return { ...pick, overallPick, round, pickInRound, draftingSlot: 8 };
});

const scenarios = [
  { name: 'early-turn', state: rebuild({ name: 'early-turn', picks: baseline.picks.slice(0, 7), currentOverallPick: 8, nextUserPick: 8, attached: true }) },
  { name: 'four-wr-balance', state: rebuild({ name: 'four-wr-balance', picks: baseline.picks.slice(0, 40), currentOverallPick: 41, nextUserPick: 41, attached: true }) },
  { name: 'forced-dst', state: rebuild({ name: 'forced-dst', picks: userRosterWithoutDst, currentOverallPick: 121, nextUserPick: 121, attached: true }) },
  { name: 'active-offline', state: rebuild({ name: 'active-offline', picks: baseline.picks.slice(0, 7), currentOverallPick: 8, nextUserPick: 8 }) },
  { name: 'completed-offline', state: baseline },
  { name: 'stale-attached', state: rebuild({ name: 'stale-attached', picks: baseline.picks.slice(0, 7), currentOverallPick: 8, nextUserPick: 8, attached: true, stale: true }) },
] as const;

const viewports = [
  { name: 'desktop', width: 1440, height: 1050 },
  { name: 'tablet', width: 1024, height: 900 },
  { name: 'mobile-wide', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
] as const;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.FDA_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const results: Array<Record<string, unknown>> = [];
try {
  for (const scenario of scenarios) {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport });
      const failures: string[] = [];
      const pageState = structuredClone(scenario.state);
      if (pageState.health.pageAttached && scenario.name !== 'stale-attached') {
        const freshTimestamp = new Date(Date.now() - 1_000).toISOString();
        pageState.health.lastObservationAt = freshTimestamp;
        pageState.health.lastReconciledAt = freshTimestamp;
      }
      page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        const content = message.text();
        if (message.type() === 'error' && !content.includes('EventSource') && !content.includes('ERR_BLOCKED_BY_CLIENT')) failures.push(`console: ${content}`);
      });
      await page.route('**/api/engine/v1/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageState) }));
      await page.route('**/api/engine/v1/events', (route) => route.abort('blockedbyclient'));
      await page.goto(origin, { waitUntil: 'domcontentloaded' });
      await page.locator('.roster-list').waitFor();

      const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
      if (dimensions.width > dimensions.viewport + 2) failures.push(`horizontal overflow ${dimensions.width}px > ${dimensions.viewport}px`);
      if ((await page.locator('.roster-list .slot-label').allTextContents()).filter((label) => label === 'FLEX').length !== 2) failures.push('roster did not render two FLEX slots');
      if ((await page.locator('.roster-list .slot-label').allTextContents()).filter((label) => /^B\d+$/.test(label)).length !== 6) failures.push('roster did not render six bench slots');

      const syncLabel = (await page.locator('.sync-button').innerText()).trim();
      const expectedSync = scenario.name === 'stale-attached' ? 'Stale' : ['active-offline', 'completed-offline'].includes(scenario.name) ? 'Offline' : 'Synced';
      if (!syncLabel.includes(expectedSync)) failures.push(`expected sync label ${expectedSync}, received ${syncLabel}`);

      if (['active-offline', 'stale-attached'].includes(scenario.name) && !(await page.locator('.freshness-warning').isVisible())) failures.push('untrusted active state did not show the decision warning');

      if (scenario.name === 'completed-offline') {
        if (!(await page.getByText('No more picks required').isVisible())) failures.push('completed state did not render completion card');
      } else {
        if (!(await page.locator('.recommendation-list').isVisible())) failures.push('active state did not render recommendations');
        const firstExplain = page.getByRole('button', { name: /^Explain / }).first();
        await firstExplain.click();
        if (!(await page.locator('.recommendation-detail').first().isVisible())) failures.push('recommendation explanation did not expand');
        await page.locator('.rec-player').first().click();
        if (!(await page.locator('.player-drawer').isVisible())) failures.push('player detail drawer did not open');
        if (['active-offline', 'stale-attached'].includes(scenario.name) && !(await page.locator('.drawer-draft').isDisabled())) failures.push('untrusted state left the copy-player action enabled');
        await page.locator('.player-drawer').getByRole('button', { name: 'Close' }).click();
        await page.locator('.player-drawer').waitFor({ state: 'hidden', timeout: 5_000 });
      }

      if (scenario.name === 'four-wr-balance' && scenario.state.recommendations.slice(0, 6).some((item) => item.position === 'WR')) failures.push('fifth WR leaked into visible recommendations');
      if (scenario.name === 'forced-dst') {
        if (!scenario.state.recommendations.length || scenario.state.recommendations.some((item) => item.position !== 'DST')) failures.push('forced endgame recommendation was not DST-only');
        if (!(await page.getByText('Must fill DST').isVisible())) failures.push('forced DST instruction was not visible');
        const liveTablePositions = await page.locator('.live-page .player-table .position-mark').allTextContents();
        if (liveTablePositions.some((position) => position !== 'DST')) failures.push('forced DST next tier included another position');
      }

      const recommendationNames = new Set(await page.locator('.recommendation-list .rec-player').allTextContents());
      const nextTierNames = await page.locator('.live-page .player-table .player-name').allTextContents();
      if (nextTierNames.some((name) => recommendationNames.has(name))) failures.push('recommended player was duplicated in the next tier');

      await page.locator('.primary-nav button').filter({ hasText: 'Players' }).click();
      const availableSwitch = page.getByRole('switch');
      if (!(await availableSwitch.isChecked())) failures.push('available-only filter was not enabled by default');
      await availableSwitch.click();
      await page.getByRole('textbox', { name: 'Search players' }).fill('Burrow');
      if (!(await page.getByText('Joe Burrow', { exact: true }).first().isVisible())) failures.push('player search did not find Joe Burrow');
      await page.getByRole('textbox', { name: 'Search players' }).fill('');
      await page.locator('.position-tabs button').filter({ hasText: /^RB$/ }).click();
      const visiblePositions = await page.locator('.player-table tbody tr .position-mark').allTextContents();
      if (visiblePositions.some((position) => position !== 'RB')) failures.push('RB position filter leaked another position');
      await page.locator('.primary-nav button').filter({ hasText: 'Live' }).click();

      await page.getByRole('button', { name: 'Open tools' }).click();
      await page.getByRole('button', { name: 'Draft board' }).click();
      if (await page.locator('.board-sheet .pick-cell').count() !== 128) failures.push('draft board did not render 128 league picks');
      await page.locator('.board-sheet').getByRole('button', { name: 'Close' }).click();
      await page.locator('.board-sheet').waitFor({ state: 'hidden', timeout: 5_000 });
      await page.locator('.sync-button').click();
      await page.getByRole('button', { name: 'Connection details' }).click();
      if (!(await page.getByRole('dialog').isVisible())) failures.push('connection dialog did not open');
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5_000 });

      const invalidAriaControls = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[aria-controls]')).filter((element) => {
        const target = element.getAttribute('aria-controls');
        return target && !document.getElementById(target);
      }).map((element) => `${element.tagName.toLowerCase()}[aria-controls=${element.getAttribute('aria-controls')}]`));
      if (invalidAriaControls.length) failures.push(`invalid aria-controls: ${invalidAriaControls.join(', ')}`);
      if (viewport.width <= 760) {
        const mobileNavBackground = await page.locator('.primary-nav').evaluate((element) => getComputedStyle(element).backgroundColor);
        if (mobileNavBackground === 'rgba(0, 0, 0, 0)') failures.push('mobile navigation background was transparent');
      }

      await page.keyboard.press('Tab');
      const focusTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
      if (!['BUTTON', 'A', 'INPUT'].includes(focusTag)) failures.push(`keyboard focus landed on ${focusTag || 'nothing'}`);

      const screenshot = `${outputDirectory}/${scenario.name}-${viewport.name}.png`;
      await page.screenshot({ path: screenshot, fullPage: true });
      if (failures.length) throw new Error(`${scenario.name}/${viewport.name}: ${failures.join('; ')}`);
      results.push({ scenario: scenario.name, viewport, screenshot, dimensions, syncLabel });
      await page.close();
    }
  }

  const freshnessPage = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const freshnessState = rebuild({ name: 'freshness-boundary', picks: baseline.picks.slice(0, 7), currentOverallPick: 8, nextUserPick: 8, attached: true });
  const boundaryTimestamp = new Date(Date.now() - 14_000).toISOString();
  freshnessState.health.lastObservationAt = boundaryTimestamp;
  freshnessState.health.lastReconciledAt = boundaryTimestamp;
  await freshnessPage.route('**/api/engine/v1/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(freshnessState) }));
  await freshnessPage.route('**/api/engine/v1/events', (route) => route.abort('blockedbyclient'));
  await freshnessPage.goto(origin, { waitUntil: 'domcontentloaded' });
  await freshnessPage.locator('.sync-button').waitFor();
  const beforeExpiry = (await freshnessPage.locator('.sync-button').innerText()).trim();
  if (!beforeExpiry.includes('Synced')) throw new Error(`freshness boundary started as ${beforeExpiry}, expected Synced`);
  await freshnessPage.waitForTimeout(2_500);
  const afterExpiry = (await freshnessPage.locator('.sync-button').innerText()).trim();
  if (!afterExpiry.includes('Stale')) throw new Error(`freshness boundary remained ${afterExpiry}, expected Stale`);
  const freshnessScreenshot = `${outputDirectory}/freshness-boundary.png`;
  await freshnessPage.screenshot({ path: freshnessScreenshot, fullPage: true });
  results.push({ scenario: 'freshness-boundary', viewport: { width: 1024, height: 900 }, screenshot: freshnessScreenshot, beforeExpiry, afterExpiry });
  await freshnessPage.close();
} finally {
  await browser.close();
}

console.log(JSON.stringify({ origin, outputDirectory, checks: results.length, results }, null, 2));
