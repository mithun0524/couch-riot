// Full loop: TV + 3 phones → join → ready → vote → play → results → next vote.
// Usage: npm run dev   (in another terminal)   then   npm run e2e
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--enable-unsafe-webgpu'] });
const fail = async (msg) => { console.error('FAIL:', msg); await browser.close(); process.exit(1); };

try {
  const tv = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
  await tv.goto(BASE + '/');
  const code = await (await tv.waitForFunction(() => window.__couch?.code, null, { timeout: 15_000 })).jsonValue();

  const phones = [];
  for (const name of ['Ana', 'Bo', 'Cy']) {
    const p = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })).newPage();
    p.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await p.goto(`${BASE}/play.html?c=${code}`);
    await p.fill('#name', name);
    await p.dblclick('button[type=submit]'); // impatient double tap must not create a ghost player
    await p.waitForSelector('body[data-screen=lobby]');
    phones.push(p);
  }

  const joined = await tv.evaluate(() => window.__couch.session.players.size);
  if (joined !== 3) await fail(`expected 3 players after double-tap joins, got ${joined}`);
  for (const p of phones) await p.click('#ready');
  await tv.waitForFunction(() => window.__couch.session.phase === 'vote');

  for (const p of phones) await p.click('[data-game=dots]');
  await tv.waitForFunction(() => window.__couch.session.phase === 'play' && window.__couch.game !== null);
  await phones[0].waitForSelector('body[data-screen=controller]');

  const x = () => tv.evaluate(() => window.__couch.game.dots.find((d) => d.slot === 0).x);
  const x0 = await x();
  await phones[0].evaluate(() => window.__phone.stick(0, 0, 3)); // full right
  await tv.waitForTimeout(1000);
  await phones[0].evaluate(() => window.__phone.stick(0, 0, 0)); // let go
  const x1 = await x();
  if (!(x1 - x0 > 100)) await fail(`dot did not move right: ${x0} → ${x1}`);
  await tv.waitForTimeout(300); // a few ticks for the release to land
  const x2 = await x();
  await tv.waitForTimeout(300);
  if ((await x()) !== x2) await fail(`dot kept moving after release: ${x2} → ${await x()}`);

  await tv.waitForFunction(() => window.__couch.session.phase === 'results', null, { timeout: 40_000 });
  await phones[0].waitForSelector('body[data-screen=results]');
  await tv.waitForFunction(() => window.__couch.session.phase === 'vote', null, { timeout: 15_000 });
  await phones[0].waitForSelector('body[data-screen=vote] [data-game=dots] small'); // "RUN IT BACK"

  if (errors.length) await fail('page errors:\n' + errors.join('\n'));
  console.log(`PASS (room ${code})`);
  await browser.close();
  process.exit(0);
} catch (e) {
  await fail(e.message);
}
