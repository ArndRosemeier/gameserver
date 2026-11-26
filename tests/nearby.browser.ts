// Nearby play in a real browser: two separate Chromium profiles ("devices") connect over WebRTC with
// no GameHub server, using the invite link and the answer code exactly as a player would.
// Also checks that the game opens offline after the first visit.
//   npm run build && npm run test:nearby
// Uses Playwright (npm i -D playwright, or a global install).
import { preview } from "vite";
import { chromium } from "playwright";
import type { Page } from "playwright";
import jsQR from "jsqr";

let failures = 0;
let hostDbg: (() => Promise<unknown>) | undefined, guestDbg: (() => Promise<unknown>) | undefined;
const dbg = (p: Page) => () => p.evaluate(() => ({ url: location.href, step: document.querySelector("#near-step")?.textContent, status: document.querySelector("#status")?.textContent, code: (document.querySelector("#near-code") as HTMLInputElement)?.value })).catch((e) => String(e));
const ok = (cond: boolean, label: string) => { console.log((cond ? "PASS " : "FAIL ") + label); if (!cond) failures++; };
const world = (p: Page) => p.evaluate(() => {
  const s = (globalThis as any).arena;
  return s?.world ? { you: s.hub.you, tick: s.world.tick, players: s.world.players } : null;
});

const srv = await preview({ configFile: "vite.config.ts", preview: { port: 5199, strictPort: true } });
const url = "http://localhost:5199/";
const browser = await chromium.launch();
try {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const host = await hostCtx.newPage();
  const guest = await guestCtx.newPage();
  hostDbg = dbg(host); guestDbg = dbg(guest);
  for (const p of [host, guest]) p.on("pageerror", (e) => console.log("page error:", e.message));

  // the guest has visited the game once (service worker installed), then loses internet
  await guest.goto(url);
  await guest.evaluate(() => navigator.serviceWorker.ready);
  await guestCtx.setOffline(true);
  await guest.reload();
  ok(await guest.waitForFunction(() => /nearby play still works/.test(document.querySelector("#rooms")!.textContent!)).then(() => true, () => false),
    "game opens offline after the first visit (and says the server is unreachable)");

  await host.goto(url);
  await host.fill("#name", "Hostie");
  await host.click("#near-host");
  await host.waitForFunction(() => (document.querySelector("#near-code") as HTMLInputElement).value.includes("#nearby="));
  const link = await host.inputValue("#near-code");
  // the QR code on screen really contains the link (rendered SVG -> pixels -> jsQR)
  const img = await host.evaluate(async () => {
    const svg = document.querySelector("#near-qr svg")!.outerHTML;
    const im = new Image();
    im.src = "data:image/svg+xml;base64," + btoa(svg);
    await im.decode();
    const c = document.createElement("canvas");
    c.width = c.height = 400;
    const x = c.getContext("2d")!;
    x.fillStyle = "#fff"; x.fillRect(0, 0, 400, 400); x.drawImage(im, 0, 0, 400, 400);
    return [...x.getImageData(0, 0, 400, 400).data];
  });
  ok(jsQR(Uint8ClampedArray.from(img), 400, 400)?.data === link, "the QR code on screen decodes to the invite link");
  ok(link.length < 300, "invite link is short enough for an easy QR code (" + link.length + " chars)");

  // Chromium's offline emulation also cuts WebRTC (a real WLAN without internet does not), so the
  // guest goes back online for the connection itself. The page itself still comes from the cache.
  await guestCtx.setOffline(false);
  // "scanning" the host's QR opens the link
  await guest.fill("#name", "Guesty");
  await guest.evaluate((l) => { location.href = l; }, link.replace("http://localhost:5199/", url));
  await guest.waitForFunction(() => (document.querySelector("#near-code") as HTMLInputElement)?.value.startsWith("G1~a~"));
  const answer = await guest.inputValue("#near-code");
  ok(answer.length < 200, "answer code is short (" + answer.length + " chars)");

  await host.fill("#near-paste", answer);
  await host.click("#near-use");
  await guest.waitForFunction(() => document.body.classList.contains("playing"), null, { timeout: 15000 });
  await host.waitForFunction(() => Object.keys((globalThis as any).arena?.world?.players ?? {}).length === 2);
  await guest.waitForFunction(() => { const s = (globalThis as any).arena; return !!s?.world?.players[String(s.hub.you)]; });
  ok(true, "guest joined the host's room directly");

  const g0 = (await world(guest))!;
  const startX = g0.players[g0.you].x;
  await guest.keyboard.down("ArrowRight");
  await guest.waitForTimeout(600);
  await guest.keyboard.up("ArrowRight");
  await guest.waitForTimeout(300);
  const h = (await world(host))!, g = (await world(guest))!;
  ok(h.players[g.you].x > startX + 50, "guest input moves the guest on the host (" + startX + " -> " + h.players[g.you].x + ")");
  ok(Math.abs(h.tick - g.tick) <= 2, "host and guest are in sync (tick " + h.tick + "/" + g.tick + ")");
  await host.waitForFunction(() => /2 playing/.test(document.querySelector("#status")!.textContent!)).catch(() => {});
  ok(/2 playing/.test(await host.textContent("#status") ?? ""), "host sees 2 players");

  // big messages are split into 16 KiB frames and put back together
  await guest.evaluate(() => { (globalThis as any).arena.hub.on("msg", (m: any) => { (globalThis as any).big = m; }); });
  await host.evaluate(() => { const s = (globalThis as any).arena; s.hub.send({ blob: "x".repeat(300_000) + "end" }); });
  ok(await guest.waitForFunction(() => (globalThis as any).big?.blob?.length === 300_003).then(() => true, () => false),
    "a 300 KB message arrives intact");

  await host.close();
  await guest.waitForFunction(() => /host left/.test(document.querySelector("#status")!.textContent!), null, { timeout: 15000 });
  ok(true, "guest is told when the host leaves");
} catch (e) {
  console.log("FAIL exception: " + (e as Error).message);
  for (const [n, c] of [["host", hostDbg], ["guest", guestDbg]] as const) console.log(n, await c?.());
  failures++;
} finally {
  await browser.close();
  await new Promise((r) => srv.httpServer.close(r));
}
console.log(failures ? failures + " FAILURE(S)" : "ALL PASS");
process.exit(failures ? 1 : 0);
