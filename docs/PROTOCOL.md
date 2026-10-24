# GameHub wire protocol

Base URL `https://games.futuremagic.de` (key-mode apps) or `https://games.futuremagic.de/access`
(cloudflare-mode apps). Everything below is relative to that base.

## HTTP
| Request | Auth | Response |
|---|---|---|
| `GET /healthz` | none | `{"ok":true}` |
| `GET /sdk.js` | none | the JavaScript client |
| `GET /v1/apps` | none | `{"apps":[{"id","name","access"}]}` |
| `GET /v1/apps/{app}/rooms` | app | `{"rooms":[RoomSummary]}` — public rooms with ≥1 player, newest first |

App auth: key mode → header `x-app-key: <key>` (or query `?key=<key>`); cloudflare mode → the
Cloudflare Access cookie/JWT, which the browser sends automatically under `/access`.
Errors are JSON: `{"error": "bad_key" | "unknown_app" | "use_access_path" | "no_access_token" | ...}`.

## WebSocket
`wss://games.futuremagic.de/v1/apps/{app}/ws?key=<key>` (key mode) or
`wss://games.futuremagic.de/access/v1/apps/{app}/ws` (cloudflare mode).
A refused upgrade closes before any message (browsers report close code 1006).

### Text frames — JSON objects with a `t` field
Any client message may carry `req` (number); the reply to it echoes the same `req`.

**Client → server**
| `t` | Fields | Who |
|---|---|---|
| `hello` | `name` | anyone — set display name (max 32 chars) |
| `lobby` | `on` (bool) | anyone — subscribe/unsubscribe to the public room list |
| `create` | `room: {name, public, maxPlayers, meta}` | anyone — creates and joins; you become host |
| `join` | `id` | anyone — room code, case-insensitive |
| `leave` | | anyone |
| `state` | `data` | host — full state |
| `delta` | `data` | host — incremental change |
| `meta` | `name?`, `public?`, `meta?` | host — room settings |
| `msg` | `data`, `to?` | anyone in a room — to one player id, or everyone else |

**Server → client**
| `t` | Fields |
|---|---|
| `welcome` | `you`, `name`, `app` — sent on connect and after `hello` |
| `joined` | `room`, `you`, `host`, `players`, `state: {seq, snapshotSeq, snapshot, deltas:[{seq,data}], complete}` |
| `state` / `delta` | `seq`, `data` |
| `msg` | `from`, `data` |
| `player+` / `player-` | `player: {id,name}` / `id` |
| `host` | `id` — new host after the previous one left |
| `room` | `room` — settings changed |
| `rooms` | `rooms` — full lobby list (reply to `lobby`) |
| `room+` / `room-` | `room` / `id` — lobby updates |
| `left` | — reply to `leave` |
| `need-snapshot` | — to the host: please send `state` |
| `error` | `code` |

`RoomSummary`: `{id, name, public, players, maxPlayers, meta, host, createdAt}`.

### Sequencing and late joiners
Every `state` and `delta` gets the room's next `seq`. The server keeps the latest snapshot plus the
deltas after it, and replays both in `joined`, so a late joiner applies: snapshot, then deltas in order.
When that history exceeds 1000 deltas or 4 MiB, it is dropped and the host is sent `need-snapshot`;
`complete:false` in `joined` means a fresh `state` is on its way.

### Binary frames
Sent as-is to everyone else in the room, prefixed with a 4-byte big-endian sender id:
`[u32 senderId][payload]`.

### Error codes
`bad_json`, `bad_message`, `unknown_type`, `not_in_room`, `not_host`, `no_such_room`,
`already_in_room`, `room_full`, `too_many_rooms`, `rate_limited`.

### Lifetimes
Players are identified per connection — a reconnect gets a new id and joins as a new player.
When the host disconnects, the player with the lowest id becomes host (`host` event).
A room with no players is kept 60 s (the same code can be re-joined), then deleted.
