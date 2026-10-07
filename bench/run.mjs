// Usage: npm run dev   (in another terminal)   then   npm run bench [url]
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/bench/';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

let allPass = true;
for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
  await page.goto(`${url}?w=${w}&h=${h}`);
  const handle = await page.waitForFunction(() => window.__bench, null, { timeout: 15 * 60_000 });
  const r = await handle.jsonValue();
  console.log(`\n${r.width}x${r.height} (CPU throttle 4x) — ${r.pass ? 'PASS' : 'FAIL'}`);
  console.table(r.rows.map((x) => ({ ...x, p50: +x.p50.toFixed(2), p99: +x.p99.toFixed(2) })));
  allPass &&= r.pass;
}
await browser.close();
process.exit(allPass ? 0 : 1);
