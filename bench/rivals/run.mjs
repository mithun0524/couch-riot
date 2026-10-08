// SPIKE (throwaway). Usage: npx vite (running), then: node bench/rivals/run.mjs <shot-dir>
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'http://localhost:5173/bench/rivals/';
const shotDir = process.argv[2] ?? '.';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const rows = [];
for (const throttle of [1, 4])
  for (const [w, h] of [[1920, 1080], [3840, 2160]])
    for (const scene of ['worst', 'calm'])
      for (const engine of ['kerf', 'pixi', 'three']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
        await page.goto(`${BASE}?engine=${engine}&w=${w}&h=${h}&scene=${scene}`);
        const r = await (await page.waitForFunction(() => window.__rival, null, { timeout: 15 * 60_000 })).jsonValue();
        await page.close();
        if (r.error) { console.log(engine, w, scene, 'ERROR', r.error); continue; }
        if (throttle === 1 && scene === 'worst') writeFileSync(`${shotDir}/${engine}-${w}.png`, Buffer.from(r.shot.split(',')[1], 'base64'));
        rows.push({ cpu: `${throttle}x`, res: `${w}x${h}`, scene, engine, p50: +r.p50.toFixed(2), p99: +r.p99.toFixed(2) });
        console.log(JSON.stringify(rows.at(-1)));
      }
await browser.close();
console.table(rows);
