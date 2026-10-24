# Patterns for games on GameHub

GameHub relays; it never interprets your state. These patterns keep games correct and cheap.

## 1. One authority: the host
Exactly one client runs the simulation — `hub.isHost`. Everyone else **only** renders what the host sends
and **only** sends intents. Never let two clients both decide the same thing (scores, collisions, spawns):
that is what diverges.

## 2. Snapshot + deltas
- `setState(world)` — the full state. Send on start, every few seconds, and whenever you get
  `need-snapshot`. Late joiners start from the latest one.
- `sendDelta(change)` — what changed this tick. Make deltas **absolute** where possible
  (`x: 274.8`, not `dx: +3`): a missed or doubled delta then cannot drift.
- Batch per tick: one delta every 50 ms beats dozens of tiny messages (and stays under 60 msg/s).
- Keep it small: round numbers, send arrays instead of objects for hot data (`[x, y, score]`).

## 3. Intents, not state, from players
Players send *what they want* — `{type:"input", input:{left:true}}`, `{type:"buy", item:"tank"}` — to
`hub.host`. The host validates and applies it. Send only on change (Arena's `setInput` does this).
After a `host` event, re-send the current intent to the new host.

## 4. Turn-based games
Same model, slower: the active player sends an intent ("move e2-e4"), the host validates, then publishes
the new board with `setState` (boards are small — skip deltas entirely).

## 5. Host migration
When the host leaves, GameHub promotes the next player. Because every client mirrors the full world,
the new host just continues: reconcile players (`hub.players`), start the tick loop, `setState`.
`example/src/net.ts` → `takeOverAsHost()` is the reference implementation.

## 6. Smoothness
Render at display rate, simulate at network rate: interpolate between the last two received positions
(or extrapolate briefly). For the local player you may predict movement and correct to the host's value.

## 7. Raw bytes for hot paths
For many units per tick, encode positions in a `Float32Array` and use `sendBinary`; receivers get
`("binary", bytes, fromId)`. Binary frames go to everyone and are not stored for late joiners, so pair
them with periodic `setState`.

## 8. Lobby metadata
Put filterable info in `meta` at `create()` (mode, map, version). Hide a running match from the lobby
with `setRoom({ public: false })`; it stays joinable by code. Include a protocol version in `meta` so
old clients can refuse to join new rooms.

## 9. Persistence
GameHub forgets everything. To save progress, the host writes to ServerStore (`store.futuremagic.de`)
and loads it into `setState` when a room starts.
