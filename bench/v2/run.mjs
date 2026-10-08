// Usage: npm run dev (another terminal), then: npm run bench:v2
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://localhost:5173/bench/v2/';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
let allPass = true;
for (const throttle of [1, 4])
  for (const [w, h] of [[1920, 1080], [3840, 2160]]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.goto(`${url}?w=${w}&h=${h}`);
    const r = await (await page.waitForFunction(() => window.__bench2, null, { timeout: 20 * 60_000 })).jsonValue();
    await page.close();
    if (r.error) { console.error('FAIL:', r.error); process.exit(1); }
    console.log(`\n${w}x${h} CPU ${throttle}x — ${r.pass ? 'PASS' : 'FAIL'}`);
    console.table(r.rows.map((x) => ({ ...x, p50: +x.p50.toFixed(2), p99: +x.p99.toFixed(2) })));
    allPass &&= r.pass;
  }
await browser.close();
process.exit(allPass ? 0 : 1);
