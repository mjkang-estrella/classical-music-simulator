// Measures frame rate for a few camera views while a piece plays.
import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto((process.env.URL ?? 'http://localhost:5173/') + (process.env.Q ?? ''));
await page.waitForFunction(() => window.__orchestra && window.__orchestra.status() !== 'loading');
await page.evaluate(() => void window.__orchestra.load('dvorak-9-iv', true));
await page.waitForFunction(() => window.__orchestra.status() === 'playing', null, { timeout: 120000 });
const fps = () => page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else res(+(n / 3).toFixed(1)); }; requestAnimationFrame(f); }));
for (const view of process.argv.slice(2).length ? process.argv.slice(2) : ['audience', 'balcony', 'strings', 'follow']) {
  await page.evaluate((v) => (v === 'follow' ? window.__orchestra.select('violin1-0') : window.__orchestra.camera(v)), view);
  await page.waitForTimeout(Number(process.env.SETTLE ?? 7000));
  console.log(view.padEnd(10), 'fps', await fps(), JSON.stringify(await page.evaluate(() => window.__orchestra.perf())));
}
await browser.close();
