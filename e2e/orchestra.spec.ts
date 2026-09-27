import { expect, test, type Page } from '@playwright/test';

// window.__orchestra is declared in src/app/debug.ts

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__orchestra && window.__orchestra.status() !== 'loading');
}

test('library lists the default pieces and the idle orchestra is seated', async ({ page }) => {
  await ready(page);
  await expect(page.locator('.piece')).toHaveCount(7);
  await expect(page.locator('.piece-title').first()).toContainText('Symphony No. 5');
  expect(await page.evaluate(() => window.__orchestra.actors())).toBeGreaterThan(50);
});

test('choosing a piece makes the orchestra perform it in sync with the score', async ({ page }) => {
  await ready(page);
  await page.locator('.piece', { hasText: 'Symphony No. 5' }).click();
  await page.waitForFunction(() => window.__orchestra.status() === 'playing', null, { timeout: 120_000 });
  await page.waitForTimeout(4000);
  const t = await page.evaluate(() => window.__orchestra.time());
  expect(t).toBeGreaterThan(2.5);
  expect(await page.evaluate(() => window.__orchestra.activeNotes())).toBeGreaterThanOrEqual(0);
  // the transport shows progress
  await expect(page.locator('.transport .time').first()).not.toHaveText('0:00');
  await page.screenshot({ path: 'test-results/audience.png' });

  // seek into a dense passage and check that notes are sounding — and audible
  await page.evaluate(() => window.__orchestra.seek(12));
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => window.__orchestra.activeNotes())).toBeGreaterThan(0);
  let peak = 0;
  for (let i = 0; i < 20; i++) {
    peak = Math.max(peak, await page.evaluate(() => window.__orchestra.audioLevel()));
    await page.waitForTimeout(100);
  }
  expect(await page.evaluate(() => window.__orchestra.silent())).toBe(false);
  expect(peak).toBeGreaterThan(0.005);
});

test('inspecting a musician shows their part and section controls', async ({ page }) => {
  await ready(page);
  await page.locator('.piece', { hasText: 'Symphony No. 5' }).click();
  await page.waitForFunction(() => window.__orchestra.status() === 'playing', null, { timeout: 120_000 });
  await page.evaluate(() => window.__orchestra.select('violin1-0'));
  await expect(page.locator('.insp-head h2')).toHaveText('Concertmaster');
  await expect(page.locator('.pianoroll canvas')).toBeVisible();
  await page.getByRole('button', { name: /Solo first violins/ }).click();
  await expect(page.getByRole('button', { name: /Solo first violins/ })).toHaveClass(/on/);
  await page.getByRole('button', { name: 'Highlight section' }).click();
  await expect(page.getByRole('button', { name: 'Highlight section' })).toHaveClass(/on/);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/inspect.png' });
});

test('clicking on a musician in the 3D view selects them', async ({ page }) => {
  await ready(page);
  await page.getByRole('navigation', { name: 'Camera views' }).getByRole('button', { name: 'Strings', exact: true }).click();
  await page.waitForTimeout(2000);
  const canvas = page.locator('canvas').first();
  const box = (await canvas.boundingBox())!;
  // sweep a few points across the lower middle of the view until someone is hit
  let selected = '';
  for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7]) {
    for (const fy of [0.55, 0.65, 0.45]) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      selected = (await page.locator('.insp-head h2').textContent().catch(() => '')) ?? '';
      if (selected) break;
    }
    if (selected) break;
  }
  expect(selected.length).toBeGreaterThan(0);
});

test('muting every section in the mixer silences the orchestra', async ({ page }) => {
  await ready(page);
  await page.locator('.piece', { hasText: 'Symphony No. 5' }).click();
  await page.waitForFunction(() => window.__orchestra.status() === 'playing', null, { timeout: 120_000 });
  await page.evaluate(() => window.__orchestra.seek(12));
  const peak = async () => {
    let p = 0;
    for (let i = 0; i < 12; i++) {
      p = Math.max(p, await page.evaluate(() => window.__orchestra.audioLevel()));
      await page.waitForTimeout(80);
    }
    return p;
  };
  await page.waitForTimeout(600);
  const before = await peak();
  await page.getByRole('tab', { name: 'Mixer' }).click();
  const mutes = page.locator('.mix-row .mini[title="Mute"]');
  const n = await mutes.count();
  expect(n).toBeGreaterThan(8);
  for (let i = 0; i < n; i++) await mutes.nth(i).click();
  await page.waitForTimeout(3000); // let the reverb tail die away
  const after = await peak();
  expect(before).toBeGreaterThan(0.005);
  expect(after).toBeLessThan(before * 0.1);
});

test('timpani sticks strike the head exactly on the beat (diagnostics piece)', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => void window.__orchestra.load('diagnostics', false));
  await page.waitForFunction(() => window.__orchestra.status() === 'ready', null, { timeout: 120_000 });
  // the selected musician is animated every frame regardless of distance
  await page.evaluate(() => window.__orchestra.select('timpani-0'));
  const beat = 60 / 96;
  const distanceAt = (t: number) =>
    page.evaluate(async (time) => {
      const o = window.__orchestra;
      o.seek(time);
      await new Promise((r) => setTimeout(r, 300));
      const a = o.orchestra.actorById('timpani-0')!;
      const v = () => a.root.position.clone();
      const tips = (['L', 'R'] as const).map((s) => a.inst!.held![s]!.getObjectByName('anchor_tip')!.getWorldPosition(v()));
      const heads = [0, 1, 2, 3].map((k) => a.inst!.anchors[`head_${k}`].getWorldPosition(v()));
      return Math.min(...tips.flatMap((tp) => heads.map((h) => tp.distanceTo(h))));
    }, t);
  for (const b of [4, 7, 12]) {
    expect(await distanceAt(b * beat)).toBeLessThan(0.01);
    expect(await distanceAt(b * beat + beat / 2)).toBeGreaterThan(0.05);
  }
});
