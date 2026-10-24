# gameserver — building multiplayer games on GameHub

GameHub (**https://games.futuremagic.de**) is a universal, in-memory relay for game state. You don't
write server code: your game connects, creates or joins a **room**, and one player — the **host** — runs
the game and publishes its state. Everyone else receives that state and sends their inputs to the host.

This project contains everything a game needs:

| Path | What |
|---|---|
| `client/gamehub.ts` | Typed client — copy this one file into your game. No dependencies. |
| `example/` | **Arena**, a complete runnable TypeScript sample (Vite + canvas). |
| `docs/PATTERNS.md` | How to structure a game on GameHub: state, deltas, inputs, host migration. |
| `docs/PROTOCOL.md` | The wire protocol, for non-TypeScript clients or debugging. |
| `lobby/` + `docs/LOBBY.md` | The lobby page at `apps.futuremagic.de/lobby/`, and how a game joins it through `apps.json`. |
| `docs/CUED.md` + `client/cued.ts` | How to list a game on cued.de (Frank's friends' portal) and read who is playing. |
| `tests/arena.e2e.ts` | Headless test that plays Arena with two clients against the live server. |

Server source and operations live in `~/projects/GameHub`.

---

## Quick start: run the sample

```bash
cd ~/projects/gameserver
npm install
cp example/.env.example example/.env.local   # already filled in on this box
npm run dev                                  # http://localhost:5174 — open it in two tabs
```
Create a room in one tab, join it from the other (lobby or room code), move with WASD/arrows.

Other scripts: `npm run build` (→ `dist/`), `npm run typecheck`,
`GAMEHUB_KEY_FILE=~/gamehub-config/arena.key npm run test:e2e`.

---

## Add GameHub to your game in 5 steps

### 1. Register the game (once, on the box)
```bash
cd ~/projects/GameHub
npm run apps -- add tank --name "Tank" --access key --max-players 8
npm run apps -- mint-key tank          # prints the app key ONCE
```
`--access key` = open to anyone with the game; `--access cloudflare` = only people who can log in through
Cloudflare Access (see *Access modes* below). Changes apply immediately, no restart.

### 2. Copy the client
Copy `client/gamehub.ts` into your game, e.g. `src/net/gamehub.ts`. (Plain-JS games can instead
`import { connect } from "https://games.futuremagic.de/sdk.js"` — same API, untyped.)

### 3. Describe your network types
Three types, all plain JSON:
```ts
type World  = { tick: number; units: Record<string, Unit> };     // full state  -> setState()
type Delta  = { tick: number; moved: Record<string, [number, number]> }; // change  -> sendDelta()
type Intent = { type: "input"; input: Controls } | { type: "chat"; text: string }; // player -> host
```

### 4. Connect, then create or join a room
```ts
import { connect } from "./net/gamehub.ts";

const hub = connect<World, Delta, Intent>({
  app: "tank",
  appKey: import.meta.env.VITE_GAMEHUB_KEY,   // key-mode apps
  // access: true,                            // cloudflare-mode apps instead of appKey
  name: "Arnd",
});
await hub.ready;

const stop = hub.watchLobby((rooms) => showLobby(rooms));   // live list of public rooms
await hub.create({ name: "Duel", maxPlayers: 2, meta: { map: "dunes" } });
// or: await hub.join("K7Q2ZP")      — 6-char code, works for private rooms too
```

### 5. Wire host and players
```ts
// everyone except the host mirrors the world
hub.on("state", (world) => { if (!hub.isHost) local = world; });
hub.on("delta", (d)     => { if (!hub.isHost) applyDelta(local, d); });

// the host collects inputs and runs the simulation
hub.on("msg", (intent, from) => { if (hub.isHost && intent.type === "input") inputs.set(from, intent.input); });
setInterval(() => {
  if (!hub.isHost) return;
  hub.sendDelta(step(local, inputs));          // ~20x per second
  if (++ticks % 40 === 0) hub.setState(local); // full snapshot every 2 s
}, 50);
hub.on("need-snapshot", () => hub.setState(local));  // the server asks for one: always answer

// players send their controls to the host (only when they change)
hub.send({ type: "input", input: controls }, hub.host!);

// host migration: whoever is promoted continues from their copy of the world
hub.on("host", (id) => { if (id === hub.you) startSimulation(); });
```
`example/src/net.ts` is a complete, tested version of exactly this, including join/leave handling and
host migration — start by copying it.

---

## Access modes

| | `key` | `cloudflare` |
|---|---|---|
| Who can play | anyone who has the game | only people allowed by the Cloudflare Access policy (currently you) |
| Client option | `appKey: "ghk_…"` | `access: true` |
| Paths | `/v1/…` | `/access/v1/…` — Cloudflare shows the login page there |
| Login | none | once per browser at `games.futuremagic.de/access/`, then cookie-based |

**App keys are not secrets.** A browser game has to ship its key, so anyone can read it from the
JavaScript (verified: the key is in Arena's built bundle). A key only says *which game* is connecting.
What protects the server: per-app room and player limits, 60 messages/s per player, 1 MiB per message,
and `npm run apps -- revoke-keys <id>` + `mint-key` if a key is abused. If a game must be private,
use `cloudflare` mode instead.

For cloudflare mode the game must be served from `https://apps.futuremagic.de` (the allowed origin) and
the player must already be logged in — send them to `https://games.futuremagic.de/access/` once.

---

## Client API (`client/gamehub.ts`)

| Member | |
|---|---|
| `ready` | promise; rejects if the server refused (bad key, not logged in, unknown app) |
| `you`, `host`, `isHost`, `room`, `players` | current identity and room |
| `on(event, fn)` → unsubscribe | events below |
| `listRooms()` | public rooms over HTTP (no socket needed) |
| `watchLobby(fn)` → stop | live public room list |
| `create({ name, public, maxPlayers, meta })` | create and join; you become host |
| `join(code)` / `leave()` | |
| `setState(world)` | **host**: full state; late joiners start here |
| `sendDelta(delta)` | **host**: incremental change, applied in order |
| `send(data, to?)` | anyone: message to one player id or everyone |
| `sendBinary(bytes)` | anyone: raw bytes to everyone (receivers get `binary`) |
| `setRoom({ name, public, meta })` | **host**: rename, hide/show in lobby, change meta |
| `close()` | |

Events: `state`, `delta`, `msg`, `binary`, `joined`, `player+`, `player-`, `host`, `room`,
`lobby`, `need-snapshot`, `incomplete`, `error`, `close`.

## Limits
1 MiB per message · 60 msg/s per player (burst 120) · per app: max rooms and players per room (set at
registration; defaults 100 / 16) · empty rooms are kept 60 s, then deleted · **nothing is stored on disk** —
if you need saves, write them to ServerStore (`store.futuremagic.de`) from the host.

## Troubleshooting
| Symptom | Cause |
|---|---|
| `ready` rejects, close code 1006 | wrong/missing app key, unknown app, or (cloudflare mode) not logged in |
| `error: not_host` | a non-host called `setState`/`sendDelta`/`setRoom` |
| `error: room_full` / `no_such_room` | capacity reached / wrong code or the room expired |
| `error: rate_limited` | over 60 msg/s — batch updates into one delta per tick |
| Node scripts on this box cannot connect | the OpenClaw egress proxy captures Node's WebSocket — set `NO_PROXY=games.futuremagic.de,127.0.0.1` |
