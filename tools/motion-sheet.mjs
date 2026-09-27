// Renders a frame-by-frame contact sheet of one musician to judge motion.
// node tools/motion-sheet.mjs <out.png> <pieceId> <musicianId> <bone> <ox,oy,oz> <start> [frames=12] [step=0.1]
import { chromium } from '@playwright/test';

const [out, piece, id, bone, off, start, framesArg, stepArg] = process.argv.slice(2);
const [ox, oy, oz] = off.split(',').map(Number);
const frames = Number(framesArg ?? 12);
const step = Number(stepArg ?? 0.1);
const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
await page.goto(process.env.URL ?? 'http://localhost:5173/');
await page.addStyleTag({ content: '.panel,.transport,.presets,.brand,.badge{display:none!important} .app{grid-template-columns:1fr!important;grid-template-rows:1fr!important}' });
await page.waitForFunction(() => window.__orchestra && window.__orchestra.status() !== 'loading');
await page.evaluate((p) => void window.__orchestra.load(p, false), piece);
await page.waitForFunction(() => window.__orchestra.status() === 'ready', null, { timeout: 120000 });
const shots = [];
for (let i = 0; i < frames; i++) {
  const t = Number(start) + i * step;
  await page.evaluate(([t, id, bone, ox, oy, oz, first]) => {
    window.__orchestra.seek(t);
    window.__orchestra.stands(false);
    if (first) setTimeout(() => window.__orchestra.lookAtBone(id, bone, ox, oy, oz), 300);
  }, [t, id, bone, ox, oy, oz, i === 0]);
  await page.waitForTimeout(i === 0 ? 800 : 250);
  shots.push({ t, b64: (await page.screenshot({ type: 'jpeg', quality: 80 })).toString('base64') });
}
const cols = 4;
const html = `<body style="margin:0;background:#000;display:grid;grid-template-columns:repeat(${cols},450px);gap:4px">${shots
  .map((s) => `<div style="position:relative"><img src="data:image/jpeg;base64,${s.b64}" style="width:450px;display:block"><span style="position:absolute;left:6px;top:4px;color:#fff;font:14px sans-serif;background:#0008;padding:1px 4px">t=${s.t.toFixed(2)}</span></div>`)
  .join('')}</body>`;
const sheet = await browser.newPage({ viewport: { width: cols * 454, height: Math.ceil(frames / cols) * 354 } });
await sheet.setContent(html);
await sheet.waitForTimeout(300);
await sheet.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('wrote', out);
