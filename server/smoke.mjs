// Live check against `wrangler dev`. Usage: node server/smoke.mjs [http://localhost:8787]
const API = process.argv[2] ?? 'http://localhost:8787';
const WS = API.replace(/^http/, 'ws');
const fail = (m) => { console.error('FAIL:', m); process.exit(1); };
setTimeout(() => fail('timed out'), 5000).unref();

function open(path) {
  return new Promise((resolve, reject) => {
    const s = new WebSocket(WS + path);
    s.binaryType = 'arraybuffer';
    const box = [];
    let wake = null;
    s.onmessage = (e) => { box.push(e.data); wake?.(); };
    s.next = async () => { while (!box.length) await new Promise((r) => (wake = r)); return box.shift(); };
    s.onopen = () => resolve(s);
    s.onerror = () => reject(new Error('socket error ' + path));
  });
}

const res = await fetch(`${API}/room`, { method: 'POST' });
if (!res.ok) fail(`POST /room → ${res.status}`);
const { code } = await res.json();
const host = await open(`/room/${code}/ws?role=host`);
const phone = await open(`/room/${code}/ws?role=phone&name=Smoke`);

const welcome = JSON.parse(await phone.next());
if (welcome.t !== 'welcome' || welcome.slot !== 0) fail('bad welcome ' + JSON.stringify(welcome));
const join = JSON.parse(await host.next());
if (join.t !== 'join' || join.name !== 'Smoke') fail('bad join ' + JSON.stringify(join));

phone.send(new Uint8Array([0x35]));
const bin = [...new Uint8Array(await host.next())];
if (bin.join() !== '0,53') fail('bad input relay ' + bin);

host.send(JSON.stringify({ to: 0, t: 'buzz', ms: 50 }));
const buzz = JSON.parse(await phone.next());
if (buzz.t !== 'buzz' || buzz.ms !== 50 || 'to' in buzz) fail('bad host relay ' + JSON.stringify(buzz));

host.close();
const gone = JSON.parse(await phone.next());
if (gone.t !== 'host-gone') fail('no host-gone ' + JSON.stringify(gone));
console.log(`PASS (room ${code})`);
process.exit(0);
