// Serverless mode without WebRTC: Arena over LocalRoomServer through in-page loopback sockets,
// plus the signal-code round trip. Run: npm run test:local
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectSocket } from "../client/gamehub.ts";
import { createLoopback, decodeSignal, encodeSignal, extractCode, hostLocal, LocalRoomServer } from "../client/local.ts";
import { ArenaSession } from "../example/src/net.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(10); }
  return pred();
}
const STILL = { up: false, down: false, left: false, right: false };

function guestOf(server: LocalRoomServer, name: string) {
  const [mine, theirs] = createLoopback();
  server.accept(theirs, { owner: false });
  return connectSocket<any, any, any>(mine, { name, fixedRoom: server.room?.id });
}

test("Arena plays over the in-page room server", async () => {
  const server = new LocalRoomServer("arena");
  const [mine, theirs] = createLoopback();
  server.accept(theirs, { owner: true });
  const host = new ArenaSession({ hub: connectSocket(mine, { name: "Host" }) });
  await host.ready;
  await host.create("table");
  assert.ok(host.isHost && host.world, "host runs the world");
  assert.equal(server.room!.public, false);

  const guest = new ArenaSession({ hub: guestOf(server, "Guest") });
  await guest.ready;
  await guest.join("anything"); // a local guest always enters the host's room
  assert.ok(await until(() => Object.keys(guest.world?.players ?? {}).length === 2), "guest mirrors both players");
  assert.equal(guest.hub.room!.id, server.room!.id);

  const gid = String(guest.hub.you);
  const startX = guest.world!.players[gid].x;
  guest.setInput({ ...STILL, right: true });
  await sleep(500);
  guest.setInput(STILL);
  await sleep(150);
  assert.ok(host.world!.players[gid].x > startX + 40, "guest input moves the guest on the host");
  assert.ok(await until(() => guest.world!.tick === host.world!.tick), "host and guest agree");

  // a late joiner starts from snapshot + deltas
  const late = new ArenaSession({ hub: guestOf(server, "Late") });
  await late.ready;
  await late.join("");
  assert.ok(await until(() => Object.keys(late.world?.players ?? {}).length === 3), "late joiner gets the world");

  // a guest leaving is removed; the host leaving ends the room
  late.close();
  assert.ok(await until(() => Object.keys(host.world!.players).length === 2), "departed guest removed");
  let closed = false;
  guest.hub.on("close", () => { closed = true; });
  host.close();
  assert.ok(await until(() => closed), "host leaving closes the room for everyone");
  guest.close();
});

test("server rules: only the owner creates, only the host publishes, room_full, binary", async () => {
  const server = new LocalRoomServer("t");
  const [mine, theirs] = createLoopback();
  server.accept(theirs, { owner: true });
  const host = connectSocket<any, any, any>(mine, { name: "H" });
  await host.ready;
  const stranger = guestOf(server, "S");
  await stranger.ready;
  await assert.rejects(stranger.create({}), /too_many_rooms/);
  await host.create({ maxPlayers: 2 });
  const g = guestOf(server, "G");
  await g.ready;
  await g.join("");
  await assert.rejects(stranger.join(server.room!.id), /room_full/);
  const errors: string[] = [];
  g.on("error", (e) => errors.push(e.code));
  g.setState({ x: 1 });
  assert.ok(await until(() => errors.includes("not_host")));
  const got: [number[], number][] = [];
  host.on("binary", (b, from) => got.push([[...b], from]));
  g.sendBinary(new Uint8Array([7, 8, 9]));
  assert.ok(await until(() => got.length === 1));
  assert.deepEqual(got[0], [[7, 8, 9], g.you]);
  const msgs: unknown[] = [];
  g.on("msg", (m) => msgs.push(m));
  host.send({ hi: 1 }, g.you!);
  assert.ok(await until(() => msgs.length === 1));
  host.close();
});

test("hostLocal works without WebRTC until the first invite", async () => {
  const hub = hostLocal({ app: "arena", name: "Solo" });
  await hub.ready;
  const room = await hub.create({ name: "x" });
  assert.equal(room.id.length, 6);
  assert.ok(hub.isHost);
  assert.deepEqual(await hub.listRooms(), []);
  await assert.rejects(hostLocal({ app: "a" }).invite(), /create\(\) a room/);
  hub.close();
});

test("signal codes keep what WebRTC needs and are short", () => {
  const sdp = [
    "v=0", "o=- 386 2 IN IP4 127.0.0.1", "s=-", "t=0 0", "a=group:BUNDLE 0", "a=extmap-allow-mixed", "a=msid-semantic: WMS",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
    "a=candidate:958873959 1 udp 2113937151 9d51191e-d32b-4e9c-8e4a-b3c1c20fe447.local 38181 typ host generation 0 network-cost 999",
    "a=candidate:2 1 udp 2113937150 192.168.1.23 38182 typ host generation 0",
    "a=candidate:3 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0",
    "a=ice-ufrag:CTMl", "a=ice-pwd:iHFy4dSB1ItV+Re0gHy1m4cx", "a=ice-options:trickle",
    "a=fingerprint:sha-256 D6:52:4A:30:2E:7C:CA:90:54:82:78:FC:98:F1:1B:0B:CC:7D:7B:D7:46:9C:41:40:42:A7:96:A1:88:50:43:D5",
    "a=setup:actpass", "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144", "",
  ].join("\r\n");
  const code = encodeSignal(sdp, "o", "K7Q2ZP", "arena");
  assert.ok(code.length < 200, "code is " + code.length + " chars");
  const back = decodeSignal("https://apps.futuremagic.de/arena/#nearby=" + encodeURIComponent(code));
  assert.equal(back.kind, "o");
  assert.equal(back.room, "K7Q2ZP");
  assert.equal(back.app, "arena");
  for (const line of [
    "a=ice-ufrag:CTMl", "a=ice-pwd:iHFy4dSB1ItV+Re0gHy1m4cx", "a=setup:actpass", "a=mid:0",
    "a=fingerprint:sha-256 D6:52:4A:30:2E:7C:CA:90:54:82:78:FC:98:F1:1B:0B:CC:7D:7B:D7:46:9C:41:40:42:A7:96:A1:88:50:43:D5",
    " 9d51191e-d32b-4e9c-8e4a-b3c1c20fe447.local 38181 typ host", " 192.168.1.23 38182 typ host",
  ]) assert.ok(back.sdp.includes(line), "missing " + line);
  assert.ok(!back.sdp.includes("tcp"), "tcp candidates dropped");
  assert.equal(extractCode("  " + code + "\n"), code);
  assert.throws(() => decodeSignal("hello"), /not a GameHub code/);
});
