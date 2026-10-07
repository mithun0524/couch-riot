import { encodeStick, isRoomCode, type HostToPhone, type RoomToPhone, type ScreenMsg, type Stick } from '../protocol';
import { attachTwinStick } from './controller';

const app = document.getElementById('app')!;
const ROOM_PORT = 8787;
const RETRY_MS = 1000;
const GIVE_UP_MS = 60_000;

let room = (new URLSearchParams(location.search).get('c') ?? '').toUpperCase();
let ws: WebSocket | null = null;
let giveUpAt = 0;
let detach: (() => void) | null = null;

const tokenKey = () => `couch-token-${room}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const store = {
  get: (s: Storage, k: string) => { try { return s.getItem(k); } catch { return null; } },
  set: (s: Storage, k: string, v: string) => { try { s.setItem(k, v); } catch { /* private mode */ } },
  del: (s: Storage, k: string) => { try { s.removeItem(k); } catch { /* private mode */ } },
};

function show(screen: string, html: string) {
  detach?.();
  detach = null;
  document.body.dataset.screen = screen;
  app.innerHTML = html;
}

function send(msg: object | Uint8Array) {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(msg instanceof Uint8Array ? msg : JSON.stringify(msg));
}

function message(title: string, body: string) {
  show('message', `<h2>${esc(title)}</h2><p>${esc(body)}</p>`);
}

function joinScreen(err = '') {
  show('join', `
    <h1>COUCH RIOT</h1>
    <form id="f">
      <label>Room<input id="code" maxlength="4" value="${esc(room)}" autocomplete="off" required></label>
      <label>Name<input id="name" maxlength="12" value="${esc(store.get(localStorage, 'couch-name') ?? '')}" autocomplete="nickname" required></label>
      <button type="submit">JOIN</button>
      <p class="err">${esc(err)}</p>
    </form>`);
  document.getElementById('f')!.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = (document.getElementById('code') as HTMLInputElement).value.trim().toUpperCase();
    const name = (document.getElementById('name') as HTMLInputElement).value.trim();
    if (!isRoomCode(code)) return joinScreen('Room codes are 4 letters');
    if (!name) return joinScreen('Pick a name');
    room = code;
    store.set(localStorage, 'couch-name', name);
    connect(name);
  });
}

function connect(name: string) {
  const token = store.get(sessionStorage, tokenKey());
  const q = `role=phone&name=${encodeURIComponent(name)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const sock = new WebSocket(`ws://${location.hostname}:${ROOM_PORT}/room/${room}/ws?${q}`);
  sock.binaryType = 'arraybuffer';
  ws = sock;
  let ended = false;
  sock.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const m = JSON.parse(e.data) as RoomToPhone | HostToPhone;
    switch (m.t) {
      case 'welcome':
        giveUpAt = 0;
        store.set(sessionStorage, tokenKey(), m.token);
        document.documentElement.style.setProperty('--me', m.color);
        message("You're in!", 'Look at the TV');
        break;
      case 'error':
        ended = true;
        message(m.code === 'room-full' ? 'Room full' : 'No room with that code', 'Check the code on the TV.');
        break;
      case 'host-gone':
        ended = true;
        store.del(sessionStorage, tokenKey());
        message('Host left', 'Scan the new code on the TV.');
        break;
      case 'buzz':
        navigator.vibrate?.(m.ms);
        break;
      case 'screen':
        render(m);
        break;
    }
  };
  sock.onclose = () => {
    if (ended || ws !== sock) return;
    if (!giveUpAt) giveUpAt = Date.now() + GIVE_UP_MS;
    if (Date.now() > giveUpAt) return message('Lost connection', 'Scan the code on the TV to rejoin.');
    show('reconnecting', '<h2>Reconnecting…</h2>');
    setTimeout(() => connect(name), RETRY_MS);
  };
}

function render(m: ScreenMsg) {
  switch (m.screen) {
    case 'lobby': {
      const { ready, players } = m.data;
      show('lobby', `
        <button id="ready" class="big ${ready ? 'on' : ''}">${ready ? 'READY ✓' : 'READY?'}</button>
        <ul class="players">${players.map((p) => `<li style="--c:${p.color}" class="${p.ready ? 'on' : ''}">${esc(p.name)}</li>`).join('')}</ul>`);
      document.getElementById('ready')!.addEventListener('click', () => send({ t: 'ready', v: !ready }));
      break;
    }
    case 'vote': {
      const { games, msLeft, mine } = m.data;
      show('vote', `
        <h2>VOTE</h2>
        <div class="bar"><i style="--ms:${msLeft}ms"></i></div>
        <div class="tiles">${games.map((g) => `
          <button class="tile ${g.id === mine ? 'mine' : ''}" data-game="${esc(g.id)}">${g.again ? '<small>RUN IT BACK</small>' : ''}${esc(g.name)}</button>`).join('')}
        </div>`);
      for (const b of app.querySelectorAll<HTMLButtonElement>('[data-game]')) {
        b.addEventListener('click', () => send({ t: 'vote', game: b.dataset.game! }));
      }
      break;
    }
    case 'controller': {
      show('controller', `
        <p class="tip">Turn your phone sideways</p>
        <div class="pad"><div class="half" id="L" data-label="MOVE"></div><div class="half" id="R" data-label="AIM"></div></div>`);
      detach = attachTwinStick(document.getElementById('L')!, document.getElementById('R')!, (b) => send(new Uint8Array([b])));
      document.documentElement.requestFullscreen?.().catch(() => { /* needs a gesture; best effort */ });
      break;
    }
    case 'results':
      show('results', `<h2>#${m.data.place}</h2><p>${m.data.score} pts</p><p>Next vote soon…</p>`);
      break;
    case 'wait':
      show('wait', '<h2>Next round soon</h2><p>Watch the TV</p>');
      break;
  }
}

// Test hook for the end-to-end script (touch is hard to drive from Playwright).
(window as unknown as { __phone: unknown }).__phone = {
  stick: (stick: Stick, dir: number, mag: number) => send(new Uint8Array([encodeStick(stick, dir, mag)])),
};

joinScreen();
