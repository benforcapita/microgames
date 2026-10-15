import { test, expect } from '@playwright/test';

const canvas2d = `<!doctype html>
<html><head><meta charset="utf-8"><title>2d</title></head>
<body style="margin:0;background:#111">
<canvas id="c" width="480" height="270"></canvas>
<script>
const c = document.getElementById('c');
const g = c.getContext('2d');
function frame() {
  g.fillStyle = '#142018';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#c4ff3d';
  g.fillRect(36, 48, 180, 120);
  g.fillStyle = '#ff4fd8';
  g.beginPath();
  g.arc(340, 130, 58, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff';
  g.font = 'bold 28px sans-serif';
  g.fillText('Preview', 58, 118);
  requestAnimationFrame(frame);
}
frame();
</script>
</body></html>`;

const webgl = `<!doctype html>
<html><head><meta charset="utf-8"><title>gl</title></head>
<body style="margin:0;background:#000">
<canvas id="c" width="480" height="270"></canvas>
<script>
const c = document.getElementById('c');
const gl = c.getContext('webgl', { alpha: false, preserveDrawingBuffer: false });
if (!gl) throw new Error('webgl missing');
function frame() {
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, c.width / 2, c.height);
  gl.clearColor(0.77, 1, 0.24, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.scissor(c.width / 2, 0, c.width / 2, c.height);
  gl.clearColor(1, 0.31, 0.85, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  requestAnimationFrame(frame);
}
frame();
</script>
</body></html>`;

const idle = `<!doctype html>
<html><head><meta charset="utf-8"><title>idle</title></head>
<body><p>This game never draws.</p></body></html>`;

function file(name, html) {
  return { name, mimeType: 'text/html', buffer: Buffer.from(html) };
}

test('upload preview captures a 2D and a WebGL canvas, and times out when nothing draws', async ({ page }) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const email = `qa-${stamp}@example.com`;
  const handle = `qa${stamp}`.slice(0, 32);

  await page.goto('/login?mode=signup&next=/upload');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill('testpass1');
  await page.getByRole('button', { name: 'Sign up' }).click();
  await page.waitForURL(/\/onboarding/);
  await page.locator('input[name="handle"]').fill(handle);
  await page.getByRole('button', { name: 'Claim handle' }).click();
  await page.waitForURL(/\/upload$/);
  await expect(page.getByRole('heading', { name: 'Upload a game' })).toBeVisible();

  const gameInput = page.locator('input[name="game"]');
  const previewButton = page.locator('#use-preview');
  const shot = page.locator('#snap-img');
  const frameEl = page.locator('#game-preview');

  async function expectSnapshot() {
    await expect(previewButton).toBeVisible({ timeout: 15_000 });
    await expect(previewButton).toHaveText('Use this preview');
    await expect(shot).toBeVisible();
    const src = await shot.getAttribute('src');
    expect(src).toMatch(/^data:image\/(webp|png)/);
    const frameSrc = await frameEl.getAttribute('src');
    expect(frameSrc?.startsWith('blob:')).toBe(true);
    expect(frameSrc).not.toContain('?');
    expect(frameSrc).not.toContain('mg_preview');
    const preview = page.frames().find((f) => f.url().startsWith('blob:'));
    expect(preview, 'preview frame').toBeTruthy();
    expect(await preview.evaluate(() => window.__MG_PREVIEW)).toBe(true);
    return src;
  }

  await gameInput.setInputFiles(file('drawn.html', canvas2d));
  const drawn = await expectSnapshot();
  await page.locator('#snap').scrollIntoViewIfNeeded();
  await page.locator('#upload-form').screenshot({ path: 'docs/pr-assets/th-1-use-this-preview.png' });

  await gameInput.setInputFiles(file('webgl.html', webgl));
  await expect(previewButton).toBeHidden();
  const glShot = await expectSnapshot();
  expect(glShot).not.toBe(drawn);

  await gameInput.setInputFiles(file('idle.html', idle));
  await expect(page.locator('#snap-msg')).toHaveText(/Capturing/);
  const started = Date.now();
  await expect(page.locator('#snap-msg')).toHaveText('No preview captured, upload one.', { timeout: 15_000 });
  const elapsed = Date.now() - started;
  expect(elapsed).toBeGreaterThanOrEqual(7_000);
  expect(elapsed).toBeLessThan(13_000);
  await expect(previewButton).toBeHidden();
});
