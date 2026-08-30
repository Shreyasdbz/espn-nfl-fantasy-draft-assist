import { mkdirSync } from 'node:fs';
import { chromium } from '../apps/engine/node_modules/playwright/index.mjs';

const origin = process.env.FDA_WEB_ORIGIN ?? 'http://127.0.0.1:3000';
const outputDirectory = process.env.FDA_VISUAL_DIR ?? '/tmp/fourth-down-visual-validation';
mkdirSync(outputDirectory, { recursive: true });

const stateResponse = await fetch(`${origin}/api/engine/v1/state`, { signal: AbortSignal.timeout(5_000) });
if (!stateResponse.ok) throw new Error(`Could not read active draft state: ${stateResponse.status}`);
const activeState = await stateResponse.json();
const expectedPositionCounts = ['QB', 'RB', 'WR', 'TE', 'K', 'DST'].map((position) => `${activeState.recommendationContext.positionCounts[position]}/${activeState.recommendationContext.positionLimits[position]}`);

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.FDA_CHROME_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
});
const results = [];
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1050 }, { name: 'mobile', width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('.roster-list').waitFor();
    const rosterLabels = await page.locator('.roster-list .slot-label').allTextContents();
    const positionCounts = await page.locator('.construction-counts small').allTextContents();
    const dimensions = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    if (rosterLabels.filter((label) => label === 'FLEX').length !== 2) throw new Error(`${viewport.name}: expected two FLEX rows`);
    if (rosterLabels.filter((label) => /^B\d+$/.test(label)).length !== 6) throw new Error(`${viewport.name}: expected six bench rows`);
    if (expectedPositionCounts.some((count) => !positionCounts.includes(count))) throw new Error(`${viewport.name}: active ESPN position counts/maxima are not visible`);
    if (viewport.name === 'mobile' && dimensions.width > dimensions.viewport + 2) throw new Error(`mobile: horizontal overflow ${dimensions.width}px > ${dimensions.viewport}px`);
    const screenshot = `${outputDirectory}/${viewport.name}.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    results.push({ viewport, screenshot, rosterLabels, positionCounts, dimensions });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(JSON.stringify({ origin, outputDirectory, results }, null, 2));
