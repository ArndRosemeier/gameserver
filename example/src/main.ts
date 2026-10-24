// main.ts - browser UI for the Arena sample: lobby, create/join, keyboard input, canvas rendering.
import { ArenaSession } from "./net.ts";
import { COIN_RADIUS, HEIGHT, PLAYER_RADIUS, WIDTH } from "./game.ts";
import type { RoomSummary } from "../../client/gamehub.ts";

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

function setStatus(text: string) { statusEl.textContent = text; }

async function ensureSession(): Promise<ArenaSession> {
  if (session) return session;
  localStorage.setItem("arena-name", nameInput.value);
  const s = new ArenaSession({ ...config, name: nameInput.value || "Player" });
  s.hub.on("close", () => setStatus("Disconnected - reload to reconnect."));
  s.hub.on("error", (e) => setStatus("Error: " + e.code));
  s.hub.on("host", () => updateHud());
  await s.ready;
  session = s;
  return s;
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
    stopLobby?.(); stopLobby = null;
    document.body.classList.add("playing");
    updateHud();
  } catch (e) {
    setStatus("Could not enter room: " + (e as Error).message);
  }
}

function updateHud() {
  if (!session) return;
  setStatus("Room " + session.roomCode + (session.isHost ? " - you are the host" : "") + " - share the code to invite.");
}

$<HTMLButtonElement>("#create").onclick = () => enter((s) => s.create(nameInput.value + "'s arena"));
$<HTMLButtonElement>("#join").onclick = () => enter((s) => s.join(codeInput.value));

// keyboard -> input (only changes go over the wire)
const keys = new Set<string>();
const syncInput = () => session?.setInput({
  up: keys.has("ArrowUp") || keys.has("w"),
  down: keys.has("ArrowDown") || keys.has("s"),
  left: keys.has("ArrowLeft") || keys.has("a"),
  right: keys.has("ArrowRight") || keys.has("d"),
});
addEventListener("keydown", (e) => { if (e.target === nameInput || e.target === codeInput) return; keys.add(e.key); syncInput(); });
addEventListener("keyup", (e) => { keys.delete(e.key); syncInput(); });
addEventListener("blur", () => { keys.clear(); syncInput(); });

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

// live lobby before joining a room
ensureSession()
  .then((s) => { stopLobby = s.watchLobby(renderLobby); setStatus("Connected to " + config.app + "."); })
  .catch((e) => setStatus("Cannot reach GameHub: " + (e as Error).message + " (check VITE_GAMEHUB_KEY)"));
