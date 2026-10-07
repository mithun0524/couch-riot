import { isRoomCode, newRoomCode } from '../shell/protocol';
import { Room } from './room';

export { Room };

interface Env { ROOM: DurableObjectNamespace<Room> }

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

    if (req.method === 'POST' && url.pathname === '/room') {
      for (let i = 0; i < 20; i++) {
        const code = newRoomCode();
        const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch('https://room/status');
        const { host } = await res.json<{ host: boolean }>();
        if (!host) return Response.json({ code }, { headers: CORS });
      }
      return new Response('no free room code', { status: 503, headers: CORS });
    }

    const m = url.pathname.match(/^\/room\/([A-Z]{4})\/ws$/);
    if (m && isRoomCode(m[1]) && req.headers.get('Upgrade') === 'websocket') {
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return new Response('not found', { status: 404, headers: CORS });
  },
};
