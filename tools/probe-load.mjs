import { chromium } from '@playwright/test';
const browser = await chromium.launch({ headless: true, channel: process.env.CHANNEL || undefined, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));
let reqs = 0; page.on('requestfinished', () => reqs++);
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`); });
await page.goto('http://localhost:5173/');
await page.waitForFunction(() => window.__orchestra && window.__orchestra.status() !== 'loading', null, { timeout: 60000 });
await page.evaluate(() => { void window.__orchestra.load('beethoven-5-i', true); });
for (let i = 0; i < 40; i++) {
  await page.waitForTimeout(3000);
  const st = await page.evaluate(() => ({ s: window.__orchestra.status(), p: document.querySelector('.progress div')?.style.width, label: document.querySelector('.overlay-label')?.textContent }));
  console.log(i * 3, JSON.stringify(st), 'requests', reqs);
  if (st.s !== 'loading') break;
}
console.log(logs.filter(l => !l.includes('Soundfont: using')).slice(-30).join('\n'));
await browser.close();
