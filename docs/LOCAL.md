# Nearby play: no server

Phones on the same WLAN (or connected to one phone's hotspot) can play a GameHub game with no
server and no internet. They connect directly over WebRTC, and the host's browser does the server's
job. The game code stays the same: it still gets a `GameHub`, so `setState`, `sendDelta`, `send`,
`sendBinary` and every event work as before. Only *finding each other* is different.

Files: `client/local.ts` (copy it next to `gamehub.ts`, no dependencies). Arena (`example/`) is the
working reference, including the QR screens (`example/src/qr.ts`) and offline caching (`vite.config.ts`).

## How players connect

Browsers can't discover each other on a network, so the two devices swap two short codes once.
Arena shows them as QR codes:

1. The host taps **Host nearby game**. A QR code appears. It is a link to the game with the invite
   in it (`.../arena/#nearby=G1~o~...`, about 160 characters).
2. The joiner scans it with the normal camera app. The game opens and shows an answer QR code.
3. The host taps **Scan with camera** and scans the answer. They are connected; the host's screen
   shows the next invite for the next player.

Each invite is for one player. Both codes can also be copied and pasted (useful on a laptop).

## Code

```ts
import { hostLocal, joinLocal } from "./net/local.ts";

// host
const hub = hostLocal<World, Delta, Intent>({ app: "tank", name: "Arnd" });
await hub.ready;
await hub.create({ name: "Kitchen table", maxPlayers: 4 });
const invite = await hub.invite();      // invite.code -> QR code
await invite.accept(scannedAnswer);     // resolves when the player is connected

// joiner (e.g. the page was opened from the host's QR link)
const { hub, answer } = await joinLocal<World, Delta, Intent>(location.hash, { app: "tank", name: "Bo" });
showQr(answer);                         // the host scans this
await hub.ready;                        // the host accepted
await hub.join("");                     // always enters the host's room
```
After that, everything is normal GameHub code (`docs/PATTERNS.md`). Arena passes these hubs into the
same `ArenaSession` it uses with the server: `new ArenaSession({ hub })`.

## Differences to the server

| | Server | Nearby |
|---|---|---|
| Finding a room | lobby, room code | QR code / pasted code, one per player |
| Host leaves | next player becomes host | the game ends for everyone (`close` event) |
| Late joiners | snapshot + deltas | the same, from the host's page |
| Limits | 60 msg/s, 1 MiB per message | none enforced; large messages are split into 16 KiB frames |
| Internet | needed | not needed, once the game page is cached (below) |

The host's page must stay open and in the foreground. On phones, a screen that turns off usually
drops the connection after a few seconds.

## Make the game open offline

Nearby play only helps without internet if the game itself loads without internet. Arena registers a
service worker (`sw.js`, generated at build time by `vite.config.ts`) that stores every built file on
the first visit; after that the game opens offline, including from the QR link. Copy that plugin and
the `navigator.serviceWorker.register("./sw.js")` line. A `manifest.webmanifest` also lets players
install the game to their home screen.

## When it won't connect

- **Different networks.** Both devices must be on the same WLAN or hotspot. Mobile data on one side
  doesn't work without a STUN/TURN server (`iceServers` option, needs internet).
- **Guest or public WLANs** often block devices from talking to each other ("client isolation").
  Use a phone hotspot instead: it always works and needs no internet.
- **The camera won't open.** The page must be served over HTTPS (it is on apps.futuremagic.de).
  Pasting the code still works.

## Why not Bluetooth?

Web Bluetooth can only connect *to* a device; a browser can't advertise itself, so two phones can't
find each other. Safari on iOS doesn't support it at all. A native app wrapper could, but then Android
and iPhone still can't easily talk to each other. WebRTC over WLAN works in every current browser.

## Tests

- `npm run test:local`: the room server rules and Arena over in-page sockets (Node, no browser).
- `npm run test:nearby`: two separate Chromium profiles connect over real WebRTC with no server,
  using the QR link and answer code like a player, plus offline loading and a 300 KB message.
