// Usage: node tools/shot.mjs <outDir> [script.json]
// Drives the running dev server with Playwright and writes screenshots. Steps are JS snippets
// evaluated in the page (window.__orchestra is available) followed by a screenshot name.
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';

const out = process.argv[2] ?? 'shots';
const steps = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : [{ wait: 3000, shot: 'initial' }];
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.env.CHANNEL ?? 'chromium',
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(process.env.URL ?? 'http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__orchestra && window.__orchestra.status() !== 'loading', null, { timeout: 60000 });
for (const s of steps) {
  if (s.eval) {
    try {
      const r = await page.evaluate(s.eval);
      if (r !== undefined) console.log('eval:', JSON.stringify(r).slice(0, 500));
    } catch (e) {
      console.log('eval error', e.message);
    }
  }
  if (s.waitFor) await page.waitForFunction(s.waitFor, null, { timeout: s.timeout ?? 120000 });
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.click) await page.mouse.click(s.click[0], s.click[1]);
  if (s.shot) await page.screenshot({ path: `${out}/${s.shot}.png` });
}
const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else res(n / 2); }; requestAnimationFrame(f); }));
console.log('fps≈', fps);
console.log(logs.filter((l) => !l.includes('[vite]') && !l.includes('Download the React DevTools')).slice(0, 40).join('\n'));
await browser.close();
