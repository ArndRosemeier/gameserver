// main.ts - the GameHub lobby: every opted-in game from apps.json, its live rooms, and its custom card.
import "./style.css";
import { fetchRooms, loadGames, roomUrl, type LobbyGame, type RoomSummary } from "./registry.ts";

const POLL_MS = 5000;

// ?registry=<url> lets you try a draft registry without deploying it.
const REGISTRY_URL =
  new URLSearchParams(location.search).get("registry") ?? import.meta.env.VITE_LOBBY_REGISTRY ?? "/apps.json";

const listEl = document.querySelector<HTMLElement>("#games")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;

type Card = {
  game: LobbyGame;
  el: HTMLElement;
  roomsEl: HTMLElement;
  countEl: HTMLElement;
  rooms: RoomSummary[];
  error: boolean;
};

let cards: Card[] = [];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text; // always textContent: room names come from players
  return el;
}

/** Only http(s) links leave the page; anything else in the registry is ignored. */
function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function link(href: string, cls: string, text: string): HTMLElement {
  const safe = safeHref(href);
  if (!safe) return h("span", cls, text);
  const a = h("a", cls, text);
  a.href = safe;
  a.target = "_blank";
  a.rel = "noopener";
  return a;
}

function buildCard(game: LobbyGame): Card {
  const el = h("article", "game");

  const info = h("div", "game-info");
  const head = h("header", "game-head");
  head.append(h("h2", "game-title", game.title));
  const countEl = h("span", "game-count");
  head.append(countEl);
  info.append(head);
  if (game.tagline) info.append(h("p", "game-tagline", game.tagline));
  info.append(link(game.path, "game-url", game.path.replace(/^https?:\/\//, "")));

  const roomsEl = h("ul", "rooms");
  info.append(roomsEl);

  const custom = h("div", "game-custom");
  if (game.gamehub.html && safeHref(game.gamehub.html)) {
    // Custom HTML lives in its own sandbox: it can run scripts and open links in a new tab,
    // but it cannot touch the lobby, its cookies or its styles.
    const frame = h("iframe", "custom-frame");
    frame.src = game.gamehub.html;
    frame.title = `${game.title}: about`;
    frame.loading = "lazy";
    frame.referrerPolicy = "no-referrer";
    frame.setAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    frame.style.height = `${Math.min(Math.max(game.gamehub.htmlHeight ?? 220, 80), 800)}px`;
    custom.append(frame);
  } else if (game.screenshot) {
    const img = h("img", "custom-shot");
    img.src = game.screenshot;
    img.alt = `${game.title} screenshot`;
    img.loading = "lazy";
    custom.append(img);
  } else {
    el.classList.add("no-custom");
  }

  el.append(info, custom);
  return { game, el, roomsEl, countEl, rooms: [], error: false };
}

function since(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

function renderRooms(card: Card) {
  const { roomsEl, countEl, game } = card;
  roomsEl.replaceChildren();
  const players = card.rooms.reduce((n, r) => n + r.players, 0);
  countEl.textContent = card.error
    ? "offline"
    : card.rooms.length
      ? `${card.rooms.length} ${card.rooms.length === 1 ? "room" : "rooms"} · ${players} playing`
      : "no rooms";
  card.el.classList.toggle("is-idle", card.rooms.length === 0);

  if (card.error) {
    roomsEl.append(h("li", "rooms-note", "GameHub did not answer for this game."));
    return;
  }
  if (!card.rooms.length) {
    const li = h("li", "rooms-note");
    li.append("No open rooms. ", link(game.path, "rooms-start", "Start one"));
    roomsEl.append(li);
    return;
  }
  for (const r of card.rooms) {
    const li = h("li", "room");
    if (r.players >= r.maxPlayers) li.classList.add("is-full");
    const name = h("span", "room-name", r.name || "Unnamed room");
    const code = h("code", "room-code", r.id);
    const seats = h("span", "room-seats", `${r.players}/${r.maxPlayers}`);
    seats.title = "players / seats";
    const age = h("span", "room-age", since(r.createdAt));
    const join = link(roomUrl(game, r.id), "room-join", r.players >= r.maxPlayers ? "Full" : "Join");
    li.append(name, code, seats, age, join);
    roomsEl.append(li);
  }
}

/** Busy games first (most players), then the quiet ones, each group alphabetical. */
function order() {
  const sorted = [...cards].sort((a, b) => {
    const pa = a.rooms.reduce((n, r) => n + r.players, 0);
    const pb = b.rooms.reduce((n, r) => n + r.players, 0);
    return pb - pa || a.game.title.localeCompare(b.game.title);
  });
  // appendChild moves existing nodes, so iframes keep their state (no reload).
  sorted.forEach((c, i) => {
    if (listEl.children[i] !== c.el) listEl.insertBefore(c.el, listEl.children[i] ?? null);
  });
}

async function refresh() {
  await Promise.all(
    cards.map(async (card) => {
      try {
        card.rooms = (await fetchRooms(card.game.gamehub)).filter((r) => r.players > 0);
        card.error = false;
      } catch {
        card.error = true;
      }
      renderRooms(card);
    }),
  );
  order();
  const live = cards.filter((c) => c.rooms.length).length;
  statusEl.textContent = `${live} of ${cards.length} ${cards.length === 1 ? "game" : "games"} running · updated ${new Date().toLocaleTimeString()}`;
}

let timer: number | undefined;
function schedule() {
  clearTimeout(timer);
  if (document.hidden) return; // no polling in background tabs
  timer = window.setTimeout(async () => {
    await refresh();
    schedule();
  }, POLL_MS);
}
document.addEventListener("visibilitychange", async () => {
  if (!document.hidden) await refresh();
  schedule();
});

async function start() {
  try {
    const games = await loadGames(REGISTRY_URL);
    if (!games.length) {
      statusEl.textContent = "";
      const empty = h("div", "empty");
      empty.append(h("h2", "", "The tables are still empty"));
      empty.append(h("p", "", "No game has joined the lobby yet. Games appear here once their apps.json entry has a gamehub block."));
      listEl.replaceChildren(empty);
      return;
    }
    cards = games.map(buildCard);
    listEl.replaceChildren(...cards.map((c) => c.el));
    await refresh();
    schedule();
  } catch (e) {
    statusEl.textContent = `Could not load the game registry (${(e as Error).message}).`;
  }
}

start();
