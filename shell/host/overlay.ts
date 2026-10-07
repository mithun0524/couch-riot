import { PALETTE_HEX } from '../protocol';
import type { Session } from './session';

export interface OverlayView { code: string; qr: string; joinUrl: string; lanOk: boolean; now: number }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));

export function overlayHtml(s: Session, v: OverlayView): string {
  const name = (slot: number) => esc(s.players.get(slot)?.name ?? '?');
  const badge = `<div class="badge"><img src="${v.qr}" alt=""><b>${v.code}</b></div>`;
  const gameName = (id: string) => esc(s.games.find((g) => g.id === id)?.name ?? id);

  switch (s.phase) {
    case 'lobby': {
      const all = [...s.players.values()].sort((a, b) => a.slot - b.slot);
      const n = s.connected().length;
      const hint = s.countdownEndsAt !== null
        ? `Starting in <b>${secs(s.countdownEndsAt - v.now)}</b>`
        : n < 2 ? 'Need at least 2 players' : 'Everyone tap READY';
      return `<section class="lobby">
        <div class="join">
          <img src="${v.qr}" alt="QR code">
          <div class="code">${v.code}</div>
          <div class="url">${esc(v.joinUrl)}</div>
          ${v.lanOk ? '' : '<div class="warn">No Wi-Fi address found — phones can’t reach this laptop. Connect to Wi-Fi and refresh.</div>'}
        </div>
        <div class="roster">${all.length
          ? all.map((p) => `<div class="p ${p.ready ? 'on' : ''} ${p.connected ? '' : 'off'}" style="--c:${PALETTE_HEX[p.slot]}">${esc(p.name)}</div>`).join('')
          : '<div class="empty">Scan to join</div>'}</div>
        <div class="hint">${hint}</div>
      </section>`;
    }
    case 'vote': {
      if (s.wheel) {
        const w = s.wheel;
        const hi = v.now >= w.endsAt - 600 ? w.options.indexOf(w.winner) : Math.floor(v.now / 120) % w.options.length;
        return `<section><h1>TIE!</h1><div class="tiles">${w.options.map((id, i) => `<div class="tile ${i === hi ? 'hot' : ''}">${gameName(id)}</div>`).join('')}</div>${badge}</section>`;
      }
      const counts = s.voteCounts();
      const top = Math.max(0, ...counts.values());
      return `<section><h1>VOTE</h1>
        <div class="tiles">${s.eligible().map((g) => {
          const c = counts.get(g.id) ?? 0;
          return `<div class="tile ${c && c === top ? 'hot' : ''}">${g.id === s.lastGame ? '<small>RUN IT BACK</small>' : ''}${esc(g.name)}<span class="n">${c}</span></div>`;
        }).join('')}</div>
        <div class="timer">${secs(s.voteEndsAt - v.now)}</div>${badge}</section>`;
    }
    case 'play':
      return badge;
    case 'results': {
      const board = [...s.players.values()].sort((a, b) => b.points - a.points);
      return `<section><div class="cols">
        <div><h2>THIS ROUND</h2><ol class="rank">${s.lastPlacings.map((p) => `<li style="--c:${PALETTE_HEX[p.slot]}"><span>${p.place}. ${name(p.slot)}</span><span>${p.score}</span></li>`).join('')}</ol></div>
        <div><h2>SESSION</h2><ol class="rank">${board.map((p) => `<li style="--c:${PALETTE_HEX[p.slot]}"><span>${esc(p.name)}</span><span>${p.points}</span></li>`).join('')}</ol></div>
      </div>${badge}</section>`;
    }
  }
}

// Only touch the DOM when the markup actually changes (timers change once a second).
export function overlayRenderer(el: HTMLElement): (s: Session, v: OverlayView) => void {
  let last = '';
  return (s, v) => {
    const html = overlayHtml(s, v);
    if (html !== last) el.innerHTML = last = html;
  };
}
