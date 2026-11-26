// local.ts - play GameHub games with no server: devices on the same WLAN (or a phone hotspot)
// connect directly over WebRTC, and the host's browser plays the server's role.
//
// Copy it next to gamehub.ts. No dependencies. The game code stays the same: you still get a GameHub,
// so setState/sendDelta/send/on("msg") etc. work unchanged. Only how players find each other differs:
// instead of a lobby, the two devices swap two short codes (show them as QR codes, see docs/LOCAL.md).
//
//   // host
//   const hub = hostLocal<World, Delta, Intent>({ app: "arena", name: "Arnd" });
//   await hub.ready;
//   await hub.create({ name: "Kitchen table", maxPlayers: 4 });
//   const invite = await hub.invite();     // invite.code -> show as QR
//   await invite.accept(answerCode);       // the code the joiner shows back -> scan it
//
//   // joiner
//   const { hub, answer } = await joinLocal<World, Delta, Intent>(inviteCode, { app: "arena", name: "Bo" });
//   showQr(answer);                        // the host scans this
//   await hub.ready;                       // resolves once the host accepted
//   await hub.join("");                    // enters the host's room (the code is in the invite)
//
// Differences to the server: no lobby (listRooms() is empty), rooms are private, and when the host
// leaves the room ends for everyone (no host migration, there is nobody left to relay).

import { connectSocket } from "./gamehub.ts";
import type { CreateRoomOptions, GameHub, PlayerInfo, RoomSummary, SocketLike } from "./gamehub.ts";

export type LocalOptions = {
  /** App id. A joiner refuses invites made by a different app. */
  app: string;
  name?: string;
  /** Only needed if devices are on different networks. Leave empty for offline play. */
  iceServers?: RTCIceServer[];
};

export interface Invite {
  /** Show this to one joiner (QR code, or copy/paste). Single use. */
  readonly code: string;
  /** Feed the joiner's answer code in. Resolves when their connection is open. */
  accept(answer: string): Promise<void>;
  cancel(): void;
}

export interface LocalHost<S = unknown, D = unknown, M = unknown> extends GameHub<S, D, M> {
  /** Host only, after create(): a new single-use invite for one more player. */
  invite(): Promise<Invite>;
}

/** Start a game on this device. This browser is the server: keep the page open while others play. */
export function hostLocal<S = unknown, D = unknown, M = unknown>(options: LocalOptions): LocalHost<S, D, M> {
  const server = new LocalRoomServer(options.app);
  const [mine, theirs] = createLoopback();
  server.accept(theirs, { owner: true });
  const hub = connectSocket<S, D, M>(mine, { name: options.name }) as LocalHost<S, D, M>;
  const close = hub.close.bind(hub);
  hub.close = () => { close(); server.close(); };
  hub.invite = async () => {
    if (!server.room) throw new Error("gamehub: create() a room before inviting");
    const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
    const socket = new ChannelSocket(pc);
    socket.bind(pc.createDataChannel("gamehub", { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    const sdp = await gathered(pc);
    let accepted = false;
    return {
      code: encodeSignal(sdp, "o", server.room.id, options.app),
      async accept(answer: string) {
        if (accepted) throw new Error("gamehub: invite already used");
        const sig = decodeSignal(answer);
        if (sig.kind !== "a") throw new Error("gamehub: that is an invite code, not an answer");
        accepted = true;
        server.accept(socket, { owner: false });
        await pc.setRemoteDescription({ type: "answer", sdp: sig.sdp });
        await socket.opened;
      },
      cancel() { if (!accepted) pc.close(); },
    };
  };
  return hub;
}

/** Answer a host's invite. Show `answer` to the host; `hub.ready` resolves once they accepted it. */
export async function joinLocal<S = unknown, D = unknown, M = unknown>(
  inviteCode: string,
  options: LocalOptions,
): Promise<{ hub: GameHub<S, D, M>; answer: string; room: string }> {
  const sig = decodeSignal(inviteCode);
  if (sig.kind !== "o") throw new Error("gamehub: that is an answer code, not an invite");
  if (sig.app !== options.app) throw new Error("gamehub: this invite is for " + sig.app + ", not " + options.app);
  const pc = new RTCPeerConnection({ iceServers: options.iceServers ?? [] });
  const socket = new ChannelSocket(pc);
  pc.ondatachannel = (e) => socket.bind(e.channel);
  const hub = connectSocket<S, D, M>(socket, { name: options.name, fixedRoom: sig.room });
  await pc.setRemoteDescription({ type: "offer", sdp: sig.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  const sdp = await gathered(pc);
  return { hub, answer: encodeSignal(sdp, "a"), room: sig.room };
}

/** Pulls an invite code out of whatever was scanned: a bare code or a URL with #nearby=<code>. */
export function extractCode(text: string): string {
  const m = /[#&?]nearby=([^&#\s]+)/.exec(text);
  return (m ? decodeURIComponent(m[1]) : text).trim();
}

// ---------------------------------------------------------------------------------------------------
// The room server. Same rules as GameHub's server (docs/PROTOCOL.md), for one room, in the host's page.

const MAX_HISTORY_DELTAS = 1000;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

type Conn = { id: number; name: string; sock: SocketLike; owner: boolean; inRoom: boolean };

export class LocalRoomServer {
  room: RoomSummary | null = null;
  private conns = new Map<number, Conn>();
  private nextId = 1;
  private seq = 0;
  private snapshot: unknown = null;
  private snapshotSeq = 0;
  private deltas: { seq: number; data: unknown }[] = [];
  private deltaBytes = 0;
  private complete = true;
  private asked = false;

  readonly app: string;
  constructor(app: string) { this.app = app; }

  /** Attach a connection. The owner (the host's own page) is the only one allowed to create the room. */
  accept(sock: SocketLike, { owner }: { owner: boolean }): void {
    const id = this.nextId++;
    const conn: Conn = { id, name: "Player " + id, sock, owner, inRoom: false };
    this.conns.set(conn.id, conn);
    const welcome = () => this.send(conn, { t: "welcome", you: conn.id, name: conn.name, app: this.app });
    if (sock.readyState === 1) welcome();
    else sock.onopen = welcome;
    sock.onmessage = (ev) => this.onMessage(conn, ev.data);
    sock.onclose = () => this.drop(conn);
    sock.onerror = () => {};
  }

  close(): void { for (const c of [...this.conns.values()]) c.sock.close(1000); }

  private send(c: Conn, msg: object): void { if (c.sock.readyState === 1) c.sock.send(JSON.stringify(msg)); }
  private members(): Conn[] { return [...this.conns.values()].filter((c) => c.inRoom); }
  private others(from: Conn): Conn[] { return this.members().filter((c) => c !== from); }
  private players(): PlayerInfo[] { return this.members().map((c) => ({ id: c.id, name: c.name })); }

  private onMessage(c: Conn, data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      if (!c.inRoom) return;
      const out = new Uint8Array(4 + data.byteLength);
      new DataView(out.buffer).setUint32(0, c.id);
      out.set(new Uint8Array(data), 4);
      for (const o of this.others(c)) if (o.sock.readyState === 1) o.sock.send(out.buffer);
      return;
    }
    let m: any;
    try { m = JSON.parse(data); } catch { return this.send(c, { t: "error", code: "bad_json" }); }
    if (!m || typeof m !== "object" || typeof m.t !== "string") return this.send(c, { t: "error", code: "bad_message" });
    const req = typeof m.req === "number" ? m.req : undefined;
    const reply = (msg: object) => this.send(c, req === undefined ? msg : { ...msg, req });
    const fail = (code: string) => reply({ t: "error", code });
    const room = this.room;
    const isHost = !!room && c.inRoom && room.host === c.id;

    switch (m.t) {
      case "hello":
        c.name = String(m.name ?? "").slice(0, 32) || c.name;
        return reply({ t: "welcome", you: c.id, name: c.name, app: this.app });
      case "lobby":
        return reply({ t: "rooms", rooms: [] });
      case "create": {
        if (!c.owner || room) return fail("too_many_rooms");
        const o: CreateRoomOptions = m.room ?? {};
        this.room = {
          id: roomCode(), name: String(o.name ?? "Local room").slice(0, 64), public: false, players: 0,
          maxPlayers: Math.max(1, Math.min(64, Number(o.maxPlayers) || 8)), meta: o.meta ?? null,
          host: c.id, createdAt: Date.now(),
        };
        return this.enter(c, req);
      }
      case "join":
        if (c.inRoom) return fail("already_in_room");
        if (!room || String(m.id ?? "").toUpperCase() !== room.id) return fail("no_such_room");
        if (room.players >= room.maxPlayers) return fail("room_full");
        return this.enter(c, req);
      case "leave":
        if (!c.inRoom) return fail("not_in_room");
        reply({ t: "left" });
        return this.exit(c);
    }
    if (!c.inRoom || !room) return fail("not_in_room");
    switch (m.t) {
      case "state":
        if (!isHost) return fail("not_host");
        this.seq++;
        this.snapshot = m.data; this.snapshotSeq = this.seq;
        this.deltas = []; this.deltaBytes = 0; this.complete = true; this.asked = false;
        for (const o of this.others(c)) this.send(o, { t: "state", seq: this.seq, data: m.data });
        return;
      case "delta":
        if (!isHost) return fail("not_host");
        this.seq++;
        if (this.complete) {
          this.deltas.push({ seq: this.seq, data: m.data });
          this.deltaBytes += data.length;
          if (this.deltas.length > MAX_HISTORY_DELTAS || this.deltaBytes > MAX_HISTORY_BYTES) {
            this.snapshot = null; this.deltas = []; this.deltaBytes = 0; this.complete = false;
          }
        }
        if (!this.complete && !this.asked) { this.asked = true; this.send(c, { t: "need-snapshot" }); }
        for (const o of this.others(c)) this.send(o, { t: "delta", seq: this.seq, data: m.data });
        return;
      case "meta":
        if (!isHost) return fail("not_host");
        if (m.name !== undefined) room.name = String(m.name).slice(0, 64);
        if (m.public !== undefined) room.public = !!m.public;
        if (m.meta !== undefined) room.meta = m.meta;
        for (const o of this.members()) this.send(o, { t: "room", room });
        return;
      case "msg": {
        const out = { t: "msg", from: c.id, data: m.data };
        if (m.to === undefined || m.to === null) { for (const o of this.others(c)) this.send(o, out); return; }
        const to = this.conns.get(Number(m.to));
        if (to?.inRoom) this.send(to, out);
        return;
      }
      default:
        return fail("unknown_type");
    }
  }

  private enter(c: Conn, req: number | undefined): void {
    const room = this.room!;
    c.inRoom = true;
    room.players = this.members().length;
    const joined: Record<string, unknown> = {
      t: "joined", room, you: c.id, host: room.host, players: this.players(),
      state: { seq: this.seq, snapshotSeq: this.snapshotSeq, snapshot: this.snapshot, deltas: this.deltas, complete: this.complete },
    };
    if (req !== undefined) joined.req = req;
    this.send(c, joined);
    for (const o of this.others(c)) this.send(o, { t: "player+", player: { id: c.id, name: c.name } });
    if (!this.complete && !this.asked) {
      const host = this.conns.get(room.host);
      if (host) { this.asked = true; this.send(host, { t: "need-snapshot" }); }
    }
  }

  private exit(c: Conn): void {
    if (!c.inRoom || !this.room) return;
    c.inRoom = false;
    this.room.players = this.members().length;
    if (this.room.host === c.id) { this.close(); return; } // the host is the server: the room ends
    for (const o of this.members()) this.send(o, { t: "player-", id: c.id });
  }

  private drop(c: Conn): void {
    this.exit(c);
    this.conns.delete(c.id);
  }
}

function roomCode(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (const b of crypto.getRandomValues(new Uint8Array(6))) s += abc[b % abc.length];
  return s;
}

// ---------------------------------------------------------------------------------------------------
// Sockets: an in-page pair for the host's own client, and a WebRTC data channel for everyone else.

/** Two connected SocketLike ends in one page. Delivery is async, like a real socket. */
export function createLoopback(): [SocketLike, SocketLike] {
  const make = () => ({
    readyState: 0, peer: null as any,
    onopen: null as SocketLike["onopen"], onmessage: null as SocketLike["onmessage"],
    onclose: null as SocketLike["onclose"], onerror: null as SocketLike["onerror"],
    send(data: string | ArrayBuffer | ArrayBufferView) {
      if (this.readyState !== 1) return;
      const copy = typeof data === "string" ? data : toBytes(data).slice().buffer;
      const peer = this.peer;
      setTimeout(() => { if (peer.readyState === 1) peer.onmessage?.({ data: copy }); }, 0);
    },
    close(code = 1000) {
      for (const end of [this, this.peer]) {
        if (end.readyState === 3) continue;
        end.readyState = 3;
        setTimeout(() => end.onclose?.({ code, reason: "" }), 0);
      }
    },
  });
  const a = make(), b = make();
  a.peer = b; b.peer = a;
  setTimeout(() => { for (const end of [a, b]) { end.readyState = 1; end.onopen?.({}); } }, 0);
  return [a as SocketLike, b as SocketLike];
}

const CHUNK = 16 * 1024 - 1; // the largest message every browser's data channel accepts
const TEXT = 1, MORE = 2;

/**
 * SocketLike over an RTCDataChannel. Every message travels as binary frames: one flag byte
 * (text or bytes, more frames follow) and up to 16 KiB of payload, so large states work everywhere.
 */
class ChannelSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  readonly opened: Promise<void>;
  private channel: RTCDataChannel | null = null;
  private parts: Uint8Array[] = [];
  private resolveOpen!: () => void;
  private rejectOpen!: (e: Error) => void;
  private lostTimer: ReturnType<typeof setTimeout> | undefined;

  private pc: RTCPeerConnection;

  constructor(pc: RTCPeerConnection) {
    this.pc = pc;
    this.opened = new Promise((res, rej) => { this.resolveOpen = res; this.rejectOpen = rej; });
    this.opened.catch(() => {});
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      clearTimeout(this.lostTimer);
      if (st === "failed" || st === "closed") this.finish(1006);
      else if (st === "disconnected") this.lostTimer = setTimeout(() => this.finish(1006), 8000);
    };
  }

  bind(ch: RTCDataChannel): void {
    this.channel = ch;
    ch.binaryType = "arraybuffer";
    const open = () => {
      if (this.readyState !== 0) return;
      this.readyState = 1; this.resolveOpen(); this.onopen?.({});
    };
    ch.onopen = open;
    ch.onclose = () => this.finish(1000);
    ch.onerror = (e) => this.onerror?.(e);
    ch.onmessage = (e) => this.receive(new Uint8Array(e.data as ArrayBuffer));
    if (ch.readyState === "open") open();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    const ch = this.channel;
    if (!ch || ch.readyState !== "open") return;
    const isText = typeof data === "string";
    const bytes = isText ? new TextEncoder().encode(data) : toBytes(data);
    let off = 0;
    do {
      const end = Math.min(off + CHUNK, bytes.length);
      const frame = new Uint8Array(1 + end - off);
      frame[0] = (isText ? TEXT : 0) | (end < bytes.length ? MORE : 0);
      frame.set(bytes.subarray(off, end), 1);
      ch.send(frame);
      off = end;
    } while (off < bytes.length);
  }

  close(code = 1000): void { this.finish(code); }

  private receive(frame: Uint8Array): void {
    this.parts.push(frame.subarray(1));
    if (frame[0] & MORE) return;
    const size = this.parts.reduce((n, p) => n + p.length, 0);
    const all = new Uint8Array(size);
    let off = 0;
    for (const p of this.parts) { all.set(p, off); off += p.length; }
    this.parts = [];
    this.onmessage?.({ data: frame[0] & TEXT ? new TextDecoder().decode(all) : all.buffer });
  }

  private finish(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this.lostTimer);
    try { this.channel?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.rejectOpen(new Error("gamehub: connection closed before it opened"));
    this.onclose?.({ code, reason: "" });
  }
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Waits for ICE gathering, so the code carries every address at once (no further signaling). */
async function gathered(pc: RTCPeerConnection, ms = 3000): Promise<string> {
  if (pc.iceGatheringState !== "complete") {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(); }
      });
    });
  }
  return pc.localDescription!.sdp;
}

// ---------------------------------------------------------------------------------------------------
// Signal codes. A data-channel SDP is ~600 characters; only ~10 values in it matter. We send those
// (about 150 characters, a small QR code) and rebuild a minimal SDP on the other side.
//   G1~<o|a>~<room>~<app>~<setup>~<mid>~<ufrag>~<pwd>~<sha-256 fingerprint, base64url>~<candidates>
// candidates: ";"-separated "<h|s>,<address>,<port>"; mDNS hostnames are packed as "m<base64url uuid>".

export type Signal = { kind: "o" | "a"; room: string; app: string; sdp: string };

export function encodeSignal(sdp: string, kind: "o" | "a", room = "", app = ""): string {
  const get = (key: string) => (sdp.match(new RegExp("^a=" + key + ":(.*)$", "m")) ?? [])[1]?.trim();
  const fp = get("fingerprint")?.split(" ") ?? [];
  if (fp[0]?.toLowerCase() !== "sha-256") throw new Error("gamehub: unsupported DTLS fingerprint");
  const fpBytes = new Uint8Array(fp[1].split(":").map((h) => parseInt(h, 16)));
  const setup = ({ actpass: "x", active: "a", passive: "p" } as Record<string, string>)[get("setup") ?? ""] ?? "x";
  const cands: string[] = [];
  for (const [, line] of sdp.matchAll(/^a=candidate:(.*)$/gm)) {
    const f = line.trim().split(" ");
    const [proto, addr, port, type] = [f[2].toLowerCase(), f[4], f[5], f[7]];
    if (proto !== "udp" || (type !== "host" && type !== "srflx")) continue;
    const uuid = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i.exec(addr);
    const a = uuid ? "m" + b64(hexBytes(uuid.slice(1).join(""))) : addr;
    const c = type[0] + "," + a + "," + port;
    if (!cands.includes(c)) cands.push(c);
  }
  return ["G1", kind, room, app, setup, get("mid") ?? "0", get("ice-ufrag"), get("ice-pwd"), b64(fpBytes), cands.slice(0, 6).join(";")].join("~");
}

export function decodeSignal(code: string): Signal {
  const parts = extractCode(code).split("~");
  if (parts[0] !== "G1" || parts.length !== 10) throw new Error("gamehub: not a GameHub code");
  const [, kind, room, app, setup, mid, ufrag, pwd, fp, cands] = parts;
  if (kind !== "o" && kind !== "a") throw new Error("gamehub: not a GameHub code");
  const hex = [...unb64(fp)].map((b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
  const lines = [
    "v=0", "o=- " + Date.now() + " 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE " + mid,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
  ];
  cands.split(";").filter(Boolean).forEach((c, i) => {
    const [t, a, port] = c.split(",");
    let addr = a;
    if (a.startsWith("m")) {
      const h = [...unb64(a.slice(1))].map((b) => b.toString(16).padStart(2, "0")).join("");
      addr = [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-") + ".local";
    }
    const host = t === "h";
    const prio = (host ? 2113937151 : 1677729535) - i;
    lines.push("a=candidate:" + (i + 1) + " 1 udp " + prio + " " + addr + " " + port + " typ " + (host ? "host" : "srflx raddr 0.0.0.0 rport 0"));
  });
  lines.push(
    "a=end-of-candidates", "a=ice-ufrag:" + ufrag, "a=ice-pwd:" + pwd, "a=fingerprint:sha-256 " + hex,
    "a=setup:" + ({ x: "actpass", a: "active", p: "passive" } as Record<string, string>)[setup],
    "a=mid:" + mid, "a=sctp-port:5000", "a=max-message-size:262144",
  );
  return { kind, room, app, sdp: lines.join("\r\n") + "\r\n" };
}

function hexBytes(hex: string): Uint8Array {
  return new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
