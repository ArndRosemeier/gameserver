// Headless end-to-end test of the Arena netcode against a live GameHub.
//   GAMEHUB_KEY_FILE=~/gamehub-config/arena.key npm run test:e2e
// Env: GAMEHUB_URL (default https://games.futuremagic.de), GAMEHUB_APP (default arena),
//      GAMEHUB_KEY or GAMEHUB_KEY_FILE.
import { readFileSync } from "node:fs";
import { ArenaSession } from "../example/src/net.ts";

const url = process.env.GAMEHUB_URL ?? "https://games.futuremagic.de";
const app = process.env.GAMEHUB_APP ?? "arena";
const appKey = process.env.GAMEHUB_KEY ?? (process.env.GAMEHUB_KEY_FILE ? readFileSync(process.env.GAMEHUB_KEY_FILE, "utf8").trim() : undefined);

let failures = 0;
const ok = (cond: boolean, label: string) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) failures++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}
const STILL = { up: false, down: false, left: false, right: false };

const host = new ArenaSession({ url, app, appKey, name: "Host" });
const guest = new ArenaSession({ url, app, appKey, name: "Guest" });
try {
  await Promise.all([host.ready, guest.ready]);
  const room = await host.create("e2e arena");
  ok(host.isHost && !!host.world, "host created room " + room.id + " and runs the world");

  await guest.join(room.id);
  ok(await until(() => Object.keys(guest.world?.players ?? {}).length === 2), "guest mirrors the world with both players");

  const gid = String(guest.hub.you);
  const startX = guest.world!.players[gid].x;
  guest.setInput({ ...STILL, right: true });
  await sleep(600);
  guest.setInput(STILL);
  await sleep(200);
  const hostX = host.world!.players[gid].x;
  const guestX = guest.world!.players[gid].x;
  ok(hostX > startX + 50, "guest input moves the guest on the host (" + startX + " -> " + hostX + ")");
  ok(Math.abs(hostX - guestX) < 0.01 && host.world!.tick === guest.world!.tick, "host and guest agree (x " + hostX + "/" + guestX + ", tick " + host.world!.tick + "/" + guest.world!.tick + ")");

  const tickBefore = guest.world!.tick;
  host.close();
  ok(await until(() => guest.isHost), "host left -> guest is promoted");
  ok(await until(() => guest.world!.tick > tickBefore + 5), "new host keeps the simulation running (tick " + tickBefore + " -> " + guest.world!.tick + ")");
  ok(Object.keys(guest.world!.players).length === 1 && !!guest.world!.players[gid], "departed host was removed from the world");
} catch (e) {
  console.log("FAIL exception: " + (e as Error).message);
  failures++;
} finally {
  host.close();
  guest.close();
}
console.log(failures ? failures + " FAILURE(S)" : "ALL PASS");
process.exit(failures ? 1 : 0);
