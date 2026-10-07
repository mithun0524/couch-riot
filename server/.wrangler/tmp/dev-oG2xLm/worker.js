var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../shell/protocol.ts
var MAX_PLAYERS = 8;
var MAX_INPUT_FRAME = 16;
var PALETTE_HEX = ["#ff3c5a", "#3cc8ff", "#78ff5a", "#ffc828", "#c85aff", "#ff8228", "#28ffc8", "#ffffff"];
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
function newRoomCode(rand = Math.random) {
  let s = "";
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}
__name(newRoomCode, "newRoomCode");
function isRoomCode(s) {
  return /^[A-HJ-NP-Z]{4}$/.test(s);
}
__name(isRoomCode, "isRoomCode");
function json(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
__name(json, "json");
var isObj = /* @__PURE__ */ __name((v) => typeof v === "object" && v !== null && !Array.isArray(v), "isObj");
function parsePhoneMsg(s) {
  const v = json(s);
  if (!isObj(v)) return null;
  if (v.t === "ready" && typeof v.v === "boolean") return { t: "ready", v: v.v };
  if (v.t === "vote" && typeof v.game === "string" && v.game.length > 0 && v.game.length <= 32) return { t: "vote", game: v.game };
  return null;
}
__name(parsePhoneMsg, "parsePhoneMsg");
function parseHostOut(s) {
  const v = json(s);
  if (!isObj(v)) return null;
  const { to, ...msg } = v;
  const okTo = to === "all" || Number.isInteger(to) && to >= 0 && to < MAX_PLAYERS;
  if (!okTo || msg.t !== "screen" && msg.t !== "buzz") return null;
  return { to, msg };
}
__name(parseHostOut, "parseHostOut");

// room.ts
import { DurableObject } from "cloudflare:workers";

// room-core.ts
var HOLD_MS = 6e4;
var NAME_MAX = 12;
var RoomCore = class {
  constructor(timers, makeToken = () => crypto.randomUUID()) {
    this.timers = timers;
    this.makeToken = makeToken;
  }
  timers;
  makeToken;
  static {
    __name(this, "RoomCore");
  }
  host = null;
  slots = Array(MAX_PLAYERS).fill(null);
  get hasHost() {
    return this.host !== null;
  }
  attachHost(conn) {
    if (this.host) return false;
    this.host = conn;
    return true;
  }
  hostClosed() {
    for (const s of this.slots) {
      if (!s) continue;
      if (s.hold !== null) this.timers.clear(s.hold);
      s.conn?.send(JSON.stringify({ t: "host-gone" }));
      s.conn?.close(1e3, "host-gone");
    }
    this.slots.fill(null);
    this.host = null;
  }
  hostMessage(data) {
    const out = parseHostOut(data);
    if (!out) return;
    const json2 = JSON.stringify(out.msg);
    if (out.to === "all") for (const s of this.slots) s?.conn?.send(json2);
    else this.slots[out.to]?.conn?.send(json2);
  }
  attachPhone(conn, rawName, token) {
    if (!this.host) return this.reject(conn, "no-room");
    let slot = token ? this.slots.findIndex((s2) => s2?.token === token) : -1;
    const back = slot >= 0;
    if (back) {
      const s2 = this.slots[slot];
      if (s2.hold !== null) this.timers.clear(s2.hold);
      s2.hold = null;
      s2.conn?.close(1e3, "replaced");
      s2.conn = conn;
    } else {
      slot = this.slots.indexOf(null);
      if (slot < 0) return this.reject(conn, "room-full");
      this.slots[slot] = { name: this.uniqueName(rawName), token: this.makeToken(), conn, hold: null };
    }
    const s = this.slots[slot];
    conn.send(JSON.stringify({ t: "welcome", slot, token: s.token, color: PALETTE_HEX[slot] }));
    this.host.send(JSON.stringify({ t: "join", slot, name: s.name, back }));
    return slot;
  }
  phoneMessage(slot, data) {
    if (!this.host || !this.slots[slot]) return;
    if (typeof data === "string") {
      const msg = parsePhoneMsg(data);
      if (msg) this.host.send(JSON.stringify({ ...msg, slot }));
      return;
    }
    if (data.length < 1 || data.length > MAX_INPUT_FRAME) return;
    const frame = new Uint8Array(data.length + 1);
    frame[0] = slot;
    frame.set(data, 1);
    this.host.send(frame);
  }
  phoneClosed(slot, conn) {
    const s = this.slots[slot];
    if (!s || s.conn !== conn) return;
    s.conn = null;
    this.host?.send(JSON.stringify({ t: "leave", slot }));
    s.hold = this.timers.set(() => {
      this.slots[slot] = null;
      this.host?.send(JSON.stringify({ t: "gone", slot }));
    }, HOLD_MS);
  }
  reject(conn, code) {
    conn.send(JSON.stringify({ t: "error", code }));
    conn.close(4001, code);
    return null;
  }
  uniqueName(raw) {
    const base = raw.trim().slice(0, NAME_MAX) || "Player";
    const taken = new Set(this.slots.filter((s) => s !== null).map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const suffix = ` ${n}`;
      const name = base.slice(0, NAME_MAX - suffix.length) + suffix;
      if (!taken.has(name)) return name;
    }
  }
};

// room.ts
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  core = new RoomCore({
    set: /* @__PURE__ */ __name((fn, ms) => setTimeout(fn, ms), "set"),
    clear: /* @__PURE__ */ __name((h) => clearTimeout(h), "clear")
  });
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/status") return Response.json({ host: this.core.hasHost });
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const conn = {
      send: /* @__PURE__ */ __name((d) => server.send(d), "send"),
      close: /* @__PURE__ */ __name((code, reason) => server.close(code ?? 1e3, reason ?? ""), "close")
    };
    if (url.searchParams.get("role") === "host") {
      if (!this.core.attachHost(conn)) {
        server.close(4e3, "host-exists");
      } else {
        server.addEventListener("message", (e) => {
          if (typeof e.data === "string") this.core.hostMessage(e.data);
        });
        server.addEventListener("close", () => this.core.hostClosed());
      }
    } else {
      const slot = this.core.attachPhone(conn, url.searchParams.get("name") ?? "", url.searchParams.get("token"));
      if (slot !== null) {
        server.addEventListener("message", (e) => {
          this.core.phoneMessage(slot, typeof e.data === "string" ? e.data : new Uint8Array(e.data));
        });
        server.addEventListener("close", () => this.core.phoneClosed(slot, conn));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
};

// worker.ts
var CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS" };
var worker_default = {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method === "POST" && url.pathname === "/room") {
      for (let i = 0; i < 20; i++) {
        const code = newRoomCode();
        const res = await env.ROOM.get(env.ROOM.idFromName(code)).fetch("https://room/status");
        const { host } = await res.json();
        if (!host) return Response.json({ code }, { headers: CORS });
      }
      return new Response("no free room code", { status: 503, headers: CORS });
    }
    const m = url.pathname.match(/^\/room\/([A-Z]{4})\/ws$/);
    if (m && isRoomCode(m[1]) && req.headers.get("Upgrade") === "websocket") {
      return env.ROOM.get(env.ROOM.idFromName(m[1])).fetch(req);
    }
    return new Response("not found", { status: 404, headers: CORS });
  }
};

// ../node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-qf8evA/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-qf8evA/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
