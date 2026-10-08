import QRCode from 'qrcode';
import { dots } from '../../games/dots/dots';
import { twinstick } from '../../games/twinstick/twinstick';
import { getDevice } from '../../engine/kerf/gpu';
import { PrimList } from '../../engine/kerf/prims';
import { Renderer } from '../../engine/kerf/renderer';
import { colorRgba, type GameInstance, type GameModule } from '../game';
import { applyInput, newPad, type Pad } from '../pad';
import type { HostOut, RoomToHost } from '../protocol';
import { handleRoomMessage } from './inbound';
import { overlayRenderer } from './overlay';
import { Session } from './session';

const GAMES: GameModule[] = [twinstick, dots];
const WORLD = { w: 1600, h: 900 };
const TICK_MS = 1000 / 60;
const ROOM = `${location.hostname}:8787`;

const overlay = document.getElementById('overlay')!;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const fatal = (msg: string) => { overlay.innerHTML = `<div class="fatal">${msg}</div>`; };

async function main() {
  let device: GPUDevice;
  try {
    device = await getDevice();
  } catch (e) {
    return fatal((e as Error).message);
  }

  const res = await fetch(`http://${ROOM}/room`, { method: 'POST' }).catch(() => null);
  if (!res?.ok) return fatal('Room server not reachable. Is <code>npm run dev</code> running?');
  const { code } = (await res.json()) as { code: string };
  const joinUrl = `http://${__LAN_HOST__}:${location.port}/play.html?c=${code}`;
  const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 340, color: { dark: '#e8ecffff', light: '#00000000' } });

  const session = new Session(GAMES.map((g) => g.meta));
  const pads: (Pad | undefined)[] = [];
  let game: GameInstance | null = null;

  const ws = new WebSocket(`ws://${ROOM}/room/${code}/ws?role=host`);
  ws.binaryType = 'arraybuffer';
  const out = (msgs: HostOut[]) => { for (const m of msgs) ws.send(JSON.stringify(m)); };
  ws.onmessage = (e) => {
    const now = Date.now();
    if (typeof e.data !== 'string') {
      const f = new Uint8Array(e.data as ArrayBuffer);
      const pad = (pads[f[0]] ??= newPad());
      for (let i = 1; i < f.length; i++) applyInput(pad, f[i]);
      return;
    }
    out(handleRoomMessage(JSON.parse(e.data) as RoomToHost, session, pads, now));
  };
  ws.onclose = () => fatal('Lost the room server. Refresh to start a new room.');

  // ponytail: canvas size is fixed at load; resizing the window needs a refresh.
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
  const renderer = new Renderer(device, canvas.width, canvas.height);
  const scale = Math.min(canvas.width / WORLD.w, canvas.height / WORLD.h);
  const cam = { x: -(canvas.width / scale - WORLD.w) / 2, y: -(canvas.height / scale - WORLD.h) / 2, scale };
  const ctx = canvas.getContext('webgpu')!;
  ctx.configure({ device, format: navigator.gpu.getPreferredCanvasFormat() });
  const prims = new PrimList();
  const drawOverlay = overlayRenderer(overlay);
  const lanOk = __LAN_HOST__ !== 'localhost';

  (window as unknown as { __couch: unknown }).__couch = { code, session, get game() { return game; } };

  let acc = 0;
  let last = performance.now();
  const frame = (t: number) => {
    const now = Date.now();
    out(session.tick(now));
    if (session.phase === 'play' && !game) {
      const mod = GAMES.find((g) => g.meta.id === session.currentGame)!;
      const players = [...session.players.values()].filter((p) => p.playing).map((p) => ({ slot: p.slot, color: colorRgba(p.slot) }));
      for (const p of players) pads[p.slot] = newPad();
      game = mod.create(players);
      acc = 0;
    }
    acc += Math.min(t - last, 250);
    last = t;
    while (game && acc >= TICK_MS) {
      game.tick(pads);
      for (const m of game.messages?.() ?? []) out([{ to: m.to, ...m.msg }]);
      acc -= TICK_MS;
      if (game.isOver()) {
        out(session.roundOver(game.result(), now));
        game = null;
      }
    }
    if (!game) acc = 0;
    prims.clear();
    game?.draw(prims);
    renderer.frame(prims, cam);
    renderer.present(ctx);
    drawOverlay(session, { code, qr, joinUrl, lanOk, now });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
