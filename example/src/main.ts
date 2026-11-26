// main.ts - browser UI for the Arena sample: lobby, create/join, nearby (serverless) play,
// keyboard and touch input, canvas rendering.
import { ArenaSession } from "./net.ts";
import { COIN_RADIUS, HEIGHT, PLAYER_RADIUS, WIDTH } from "./game.ts";
import type { Input } from "./game.ts";
import type { RoomSummary } from "../../client/gamehub.ts";
import { extractCode, hostLocal, joinLocal } from "../../client/local.ts";
import type { Invite, LocalHost } from "../../client/local.ts";
import { scanQr, showQr } from "./qr.ts";

const env = import.meta.env;
const config = {
  url: env.VITE_GAMEHUB_URL || "https://games.futuremagic.de",
  app: env.VITE_GAMEHUB_APP || "arena",
  appKey: env.VITE_GAMEHUB_KEY || undefined,
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const nameInput = $<HTMLInputElement>("#name");
const lobbyEl = $<HTMLUListElement>("#rooms");
const statusEl = $<HTMLDivElement>("#status");
const codeInput = $<HTMLInputElement>("#code");
const canvas = $<HTMLCanvasElement>("#arena");
const ctx = canvas.getContext("2d")!;
canvas.width = WIDTH;
canvas.height = HEIGHT;

nameInput.value = localStorage.getItem("arena-name") ?? "Player" + Math.floor(Math.random() * 1000);
let session: ArenaSession | null = null;
let stopLobby: (() => void) | null = null;
const playerName = () => { localStorage.setItem("arena-name", nameInput.value); return nameInput.value || "Player"; };

function setStatus(text: string) { statusEl.textContent = text; }

function useSession(s: ArenaSession, offline = false): ArenaSession {
  session = s;
  s.hub.on("close", () => session === s && setStatus(offline ? "The host left - the nearby game is over." : "Disconnected - reload to reconnect."));
  s.hub.on("error", (e) => setStatus("Error: " + e.code));
  s.hub.on("host", () => updateHud());
  s.hub.on("player+", () => updateHud());
  s.hub.on("player-", () => updateHud());
  return s;
}

async function ensureSession(): Promise<ArenaSession> {
  if (session) return session;
  const s = new ArenaSession({ ...config, name: playerName() });
  await s.ready;
  if (session) { s.close(); return session; } // a nearby game started meanwhile
  return useSession(s);
}

function renderLobby(rooms: RoomSummary[]) {
  lobbyEl.replaceChildren();
  if (!rooms.length) { lobbyEl.innerHTML = "<li class='empty'>No open rooms - create one.</li>"; return; }
  for (const r of rooms) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = "Join";
    btn.disabled = r.players >= r.maxPlayers;
    btn.onclick = () => enter((s) => s.join(r.id));
    li.append(r.name + " (" + r.players + "/" + r.maxPlayers + ") ", btn);
    lobbyEl.append(li);
  }
}

async function enter(action: (s: ArenaSession) => Promise<RoomSummary>) {
  try {
    const s = await ensureSession();
    await action(s);
    startPlaying();
  } catch (e) {
    setStatus("Could not enter room: " + (e as Error).message);
  }
}

function startPlaying() {
  stopLobby?.(); stopLobby = null;
  document.body.classList.add("playing");
  updateHud();
}

function updateHud() {
  if (!session?.roomCode) return;
  if (nearbyHost) {
    setStatus("Nearby game - you are the host, keep this page open. " + session.hub.players.length + " playing.");
  } else if (nearbyGuest) {
    setStatus("Nearby game - connected directly to the host.");
  } else {
    setStatus("Room " + session.roomCode + (session.isHost ? " - you are the host" : "") + " - share the code to invite.");
  }
}

$<HTMLButtonElement>("#create").onclick = () => enter((s) => s.create(nameInput.value + "'s arena"));
$<HTMLButtonElement>("#join").onclick = () => enter((s) => s.join(codeInput.value));

// ---- nearby play: no server, the host's browser relays (client/local.ts) --------------------------

const panel = $<HTMLElement>("#nearby");
const stepEl = $<HTMLParagraphElement>("#near-step");
const qrEl = $<HTMLDivElement>("#near-qr");
const codeRow = $<HTMLDivElement>("#near-code-row");
const codeOut = $<HTMLInputElement>("#near-code");
const inputRow = $<HTMLDivElement>("#near-input-row");
const video = $<HTMLVideoElement>("#near-video");
const pasteInput = $<HTMLInputElement>("#near-paste");
let nearbyHost: LocalHost | null = null;
let nearbyGuest = false;
let invite: Invite | null = null;
let onCode: (code: string) => void = () => {};
let stopScan: (() => void) | null = null;

/** One step of the handshake: what to say, which code to show (if any), and what to do with a scanned code. */
function nearbyStep(text: string, show: string | null, expect: ((code: string) => void) | null) {
  panel.hidden = false;
  document.body.classList.add("nearby");
  stepEl.textContent = text;
  qrEl.hidden = codeRow.hidden = !show;
  if (show) { showQr(qrEl, show); codeOut.value = show; }
  inputRow.hidden = !expect;
  onCode = expect ?? (() => {});
  stopScan?.(); stopScan = null; video.hidden = true;
}

const inviteLink = (code: string) => location.href.split("#")[0] + "#nearby=" + code; // codes only use URL-safe characters

async function hostNearby() {
  try {
    leaveServer();
    nearbyHost = hostLocal({ app: config.app, name: playerName() });
    const s = useSession(new ArenaSession({ hub: nearbyHost }), true);
    await s.ready;
    await s.create(nameInput.value + "'s table");
    startPlaying();
    await nextInvite();
  } catch (e) {
    setStatus("Could not host: " + (e as Error).message);
  }
}

async function nextInvite() {
  if (!nearbyHost) return;
  const room = nearbyHost.room!;
  if (room.players >= room.maxPlayers) { nearbyStep("The room is full.", null, null); return; }
  stepEl.textContent = "Preparing an invite...";
  invite = await nearbyHost.invite();
  nearbyStep(
    "1. Let the other player scan this with their camera (or open the game and paste the code). " +
      "2. Then scan the code their screen shows.",
    inviteLink(invite.code),
    async (answer) => {
      const inv = invite!;
      nearbyStep("Connecting...", null, null);
      try {
        await withTimeout(inv.accept(answer), 15000);
        updateHud();
        await nextInvite();
      } catch (e) {
        inv.cancel();
        setStatus("That did not connect: " + (e as Error).message + ". Are both devices on the same WLAN?");
        await nextInvite();
      }
    },
  );
}

async function joinNearby(inviteCode: string) {
  try {
    leaveServer();
    setStatus("");
    nearbyStep("Reading the invite...", null, null);
    const { hub, answer } = await joinLocal(extractCode(inviteCode), { app: config.app, name: playerName() });
    nearbyGuest = true;
    const s = useSession(new ArenaSession({ hub }), true);
    nearbyStep("Now let the host scan this code.", answer, null);
    await withTimeout(s.ready, 120000);
    await s.join("");
    history.replaceState(null, "", location.href.split("#")[0]);
    panel.hidden = true;
    startPlaying();
  } catch (e) {
    nearbyGuest = false;
    session?.close(); session = null;
    nearbyStep("Could not join: " + (e as Error).message + ". Scan the host's code again.", null, joinNearby);
  }
}

function leaveServer() {
  stopLobby?.(); stopLobby = null;
  session?.close(); session = null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
}

$<HTMLButtonElement>("#near-host").onclick = hostNearby;
$<HTMLButtonElement>("#near-join").onclick = () => nearbyStep("Scan the code on the host's screen.", null, joinNearby);
$<HTMLButtonElement>("#near-use").onclick = () => { const c = pasteInput.value.trim(); pasteInput.value = ""; if (c) onCode(c); };
$<HTMLButtonElement>("#near-copy").onclick = () => navigator.clipboard?.writeText(codeOut.value);
$<HTMLButtonElement>("#near-done").onclick = () => {
  stopScan?.(); stopScan = null; panel.hidden = true;
  if (!nearbyHost && !nearbyGuest) document.body.classList.remove("nearby");
  $<HTMLButtonElement>("#near-invite").hidden = !nearbyHost;
};
$<HTMLButtonElement>("#near-invite").onclick = (e) => { (e.target as HTMLElement).hidden = true; panel.hidden = false; };
$<HTMLButtonElement>("#near-scan").onclick = async () => {
  try {
    video.hidden = false;
    const handler = onCode;
    stopScan = await scanQr(video, (text) => { video.hidden = true; stopScan = null; handler(text); });
  } catch (e) {
    video.hidden = true;
    setStatus("Camera not available (" + (e as Error).message + ") - paste the code instead.");
  }
};

// ---- input: keyboard, or touch and hold towards where you want to go -----------------------------

const keys = new Set<string>();
let touchInput: Input | null = null;
const syncInput = () => session?.setInput(touchInput ?? {
  up: keys.has("ArrowUp") || keys.has("w"),
  down: keys.has("ArrowDown") || keys.has("s"),
  left: keys.has("ArrowLeft") || keys.has("a"),
  right: keys.has("ArrowRight") || keys.has("d"),
});
addEventListener("keydown", (e) => { if (e.target instanceof HTMLInputElement) return; keys.add(e.key); syncInput(); });
addEventListener("keyup", (e) => { keys.delete(e.key); syncInput(); });
addEventListener("blur", () => { keys.clear(); touchInput = null; syncInput(); });

function pointerInput(e: PointerEvent) {
  const me = session?.world?.players[String(session.hub.you)];
  if (!me || !e.buttons) { touchInput = null; syncInput(); return; }
  const r = canvas.getBoundingClientRect();
  const dx = (e.clientX - r.left) * (WIDTH / r.width) - me.x;
  const dy = (e.clientY - r.top) * (HEIGHT / r.height) - me.y;
  const dead = PLAYER_RADIUS;
  touchInput = { left: dx < -dead, right: dx > dead, up: dy < -dead, down: dy > dead };
  syncInput();
}
canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pointerInput(e); });
canvas.addEventListener("pointermove", pointerInput);
canvas.addEventListener("pointerup", () => { touchInput = null; syncInput(); });
canvas.addEventListener("pointercancel", () => { touchInput = null; syncInput(); });

function draw() {
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  const world = session?.world;
  if (world) {
    ctx.fillStyle = "#facc15";
    ctx.beginPath(); ctx.arc(world.coin.x, world.coin.y, COIN_RADIUS, 0, Math.PI * 2); ctx.fill();
    const board: string[] = [];
    for (const p of Object.values(world.players)) {
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, PLAYER_RADIUS, 0, Math.PI * 2); ctx.fill();
      if (p.id === session!.hub.you) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = "#e5e7eb"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(p.name, p.x, p.y - PLAYER_RADIUS - 6);
      board.push(p.name + ": " + p.score);
    }
    ctx.textAlign = "left"; ctx.fillText(board.join("   "), 10, 18);
  }
  requestAnimationFrame(draw);
}
requestAnimationFrame(draw);

// offline support: the built game caches itself (sw.js, generated by vite.config.ts)
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

// Opened from a host's QR code: join that nearby game. Otherwise show the live server lobby.
const linked = /[#&]nearby=/.test(location.hash) ? location.hash : null;
addEventListener("hashchange", () => { if (/[#&]nearby=/.test(location.hash) && !nearbyHost && !nearbyGuest) joinNearby(location.hash); });
if (linked) {
  joinNearby(linked);
} else {
  ensureSession()
    .then((s) => { if (session === s && !s.roomCode) { stopLobby = s.watchLobby(renderLobby); setStatus("Connected to " + config.app + "."); } })
    .catch((e) => {
      lobbyEl.innerHTML = "<li class='empty'>Server not reachable - nearby play still works.</li>";
      if (!session) setStatus("Cannot reach GameHub: " + (e as Error).message);
    });
}

// for debugging in the console (and the browser test): arena.world, arena.hub
Object.defineProperty(globalThis, "arena", { get: () => session, configurable: true });
