import { DurableObject } from 'cloudflare:workers';
import { RoomCore, type Conn } from './room-core';

// ponytail: non-hibernating sockets keep the object (and its in-memory membership + hold timers) alive while
// the host is connected; switch to the hibernation API + storage if rooms must survive eviction.
export class Room extends DurableObject {
  private core = new RoomCore({
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/status') return Response.json({ host: this.core.hasHost });

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const conn: Conn = {
      send: (d) => server.send(d),
      close: (code, reason) => server.close(code ?? 1000, reason ?? ''),
    };

    if (url.searchParams.get('role') === 'host') {
      if (!this.core.attachHost(conn)) {
        server.close(4000, 'host-exists');
      } else {
        server.addEventListener('message', (e) => {
          if (typeof e.data === 'string') this.core.hostMessage(e.data);
        });
        server.addEventListener('close', () => this.core.hostClosed());
      }
    } else {
      const slot = this.core.attachPhone(conn, url.searchParams.get('name') ?? '', url.searchParams.get('token'));
      if (slot !== null) {
        server.addEventListener('message', (e) => {
          this.core.phoneMessage(slot, typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer));
        });
        server.addEventListener('close', () => this.core.phoneClosed(slot, conn));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}
