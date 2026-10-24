# How to connect a game to cued

[cued](https://cued.de) is Frank Zimmer's private, invitation-only friends' portal. It has events, chat,
"friends online", invitations and a games section. A friend who builds a game can list it there as a
**guest game**:

- The game keeps running on **your own server**, for example `https://apps.futuremagic.de/<game>/`.
- cued shows it inside a sandboxed iframe on `https://cued.de/spiele/<slug>/`.
- cued tells the game **who is playing** by appending a signed pass to the URL.

This guide covers everything a game needs to do. It works for any web game, and it fits GameHub games
especially well. Tank Battle is the reference implementation (`src/cued/`, `src/entry/cued.ts`,
`CUED.md` in `ArndRosemeier/Tank-battle`).

| Path | What |
|---|---|
| `client/cued.ts` | Pass reader. Copy this one file into your game. It has no dependencies. |
| `tests/cued.test.ts` | Tests that build passes exactly as cued does (`npm run test:cued`). |

---

## Checklist

1. Your page must allow being framed by cued (see [Server requirements](#1-server-requirements)).
2. Register the game on cued's developer page and keep the key on a server only (see [Register](#2-register-the-game-in-cued)).
3. Copy `client/cued.ts` and call `loadCuedSession()` once at startup (see [Read the pass](#4-read-the-pass-in-the-game)).
4. Show the player's name and avatar. For GameHub games, use the name as the player name (see [Multiplayer](#6-multiplayer-through-gamehub)).
5. Test inside a frame and also without one. Without a pass, the game must run exactly as before.

---

## 1. Server requirements

The game page must be served over **https**, and it must allow being framed by cued:

- Send **no** `X-Frame-Options: DENY` or `SAMEORIGIN`.
- If you send a Content-Security-Policy, it must include `frame-ancestors https://cued.de`.
  Keep `'self'` too if you also frame the game yourself.

```
Content-Security-Policy: frame-ancestors 'self' https://cued.de
```

`apps.futuremagic.de` currently sends neither header, so games there can already be framed. Check yours
with `curl -sI https://<your-game-url>/ | grep -iE 'x-frame|content-security'`.

## 2. Register the game in cued

1. A cued member with the **developer** flag opens `https://cued.de/entwickler/`, enters the game's name
   and its https address, and cued derives a **slug** from the name, for example `tank-battle`. That slug
   is the pass's `aud`.
2. The game's developer page shows a **key**. Treat it as a **secret**, unlike GameHub app keys. It signs
   the passes, and it can be regenerated there. Keep it only on a server (an env var or a key file on the
   box), and never put it in the client bundle or the repo.
3. On the same page you set the texts, a preview image and the visibility. The steps are *developer only*,
   then *testers*, then *all members*. The developer decides when to release.

## 3. How cued opens the game

```html
<iframe src="https://apps.futuremagic.de/tank-battle/#cued=<PASS>"
        allow="fullscreen; gamepad; autoplay" allowfullscreen referrerpolicy="origin"
        sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms"></iframe>
```

Here is what the sandbox means for your game:

| Works | Does not work |
|---|---|
| Scripts, your own origin's `localStorage`/`sessionStorage`, WebSockets (GameHub), fetch | Navigating the **top** window (`window.top.location = …`) |
| Pointer lock, fullscreen, gamepad, autoplaying audio | `alert`/`confirm`/`prompt` (no `allow-modals`). Use in-page dialogs. |
| Popups (`target="_blank"` links), forms | Downloads (no `allow-downloads`) |
| Reloading or navigating **inside** the frame (`location.assign('?mode=…')`) | |

The page around the frame (online status, invitation notices, spectator controls) is cued's. Your game
does not need to do anything for it.

## 4. Read the pass in the game

The pass is a compact JWT (HS256), appended as a URL **fragment**: `#cued=<JWT>`. A fragment is never
sent to your server in requests. Its claims:

| Claim | Meaning |
|---|---|
| `iss` | always `"cued"` |
| `aud` | the game's slug in cued |
| `iat`, `exp` | issued and expires (Unix seconds), valid for **6 hours** |
| `sub` | the player's **stable id** in cued (a number as a string). Use this as the player key. |
| `name` | display name, as friends see it everywhere in cued |
| `kuerzel` | initials for the avatar circle |
| `hg`, `schrift` | avatar circle background and text colour (CSS colours) |
| `bild` | URL of a 128 px avatar image (no cued login needed, CORS `*`), or `""` |
| `raum` | room id when the game was opened from a cued invitation, else `null` |
| `cued` | cued's base URL (`https://cued.de/`) |

The member's login name and everything else about them stay inside cued.

```ts
import { loadCuedSession, CuedPassError } from "./net/cued.ts";

let cued = null;
try {
  cued = loadCuedSession("my-game.cued-pass");   // sessionStorage key, one per game
} catch (e) {
  showError(e);                                   // malformed pass: show it, don't invent a player
}
if (cued) {
  const { name, initials, circle, avatarUrl } = cued.identity;
  if (cued.expired) showHint("Your cued pass expired, reopen the game from cued.");
  else showPlayerBadge(name, avatarUrl ?? { initials, ...circle });
}
// no pass: the game was not opened from cued, so run as before
```

`loadCuedSession` reads the fragment once and **removes it from the address bar**, so it doesn't end up
in copied links or screenshots. It also keeps the pass in this tab's `sessionStorage`, because cued adds
the fragment only to the first URL and your own navigations drop it. The pure functions
(`decodeCuedPass`, `isCuedPassExpired`, `cuedPassFromHash`, `hashWithoutCuedPass`) run in node too.

## 5. Trust: read in the browser, verify on a server

The browser cannot verify the pass, because that would need the key in the bundle. So:

- **In the client**, use the claims for **display only**: name, avatar, a pre-filled player name.
- **On a server**, verify anything that matters: a result for HiScores, entry to something private, or
  anything where a fake name would hurt. Send the raw pass (`identity.token`) to that server and verify
  it there:

```ts
// Node, with jose
import { jwtVerify } from "jose";
const { payload } = await jwtVerify(pass, new TextEncoder().encode(process.env.CUED_KEY!), {
  issuer: "cued", audience: "my-game",
});
// payload.sub = player id, payload.raum = room
```

```ts
// Node, no dependencies
import { createHmac, timingSafeEqual } from "node:crypto";
function verifyCuedPass(pass: string, key: string, slug: string) {
  const [head, body, sig] = pass.split(".");
  const want = createHmac("sha256", key).update(`${head}.${body}`).digest();
  const got = Buffer.from(sig ?? "", "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error("bad signature");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (claims.iss !== "cued" || claims.aud !== slug) throw new Error("wrong issuer or game");
  if (Date.now() / 1000 >= claims.exp) throw new Error("expired");
  return claims;
}
```

## 6. Multiplayer through GameHub

cued does **not** carry game traffic. Use GameHub for rooms as usual (see the README and
`PATTERNS.md`). There is no separate relay for cued games. Today's integration:

- **Player name:** pass the cued `name` as GameHub's `name` (`connect({ ..., name: cued.identity.name })`),
  or pre-fill your name field with it. Friends then see each other under their cued names.
- **Joining by link:** a `?room=<GameHub code>` link already works inside the frame, because the game
  reads the query string as it does anywhere else.

Coming next, once cued's invitation bridge exists:

- **Invitations:** the game asks cued (via `postMessage` to the parent page) to invite a friend, and the
  friend's pass then carries the same `raum`. GameHub chooses room codes itself, so the host creates the
  room with `meta: { cuedRaum: raum }`. Invitees with that `raum` find it with `hub.listRooms()` (public
  rooms) and join by its code. For a private room, the host tells cued the GameHub code instead.
- **Results and HiScores:** GameHub runs no game code and holds no keys, so a small endpoint on the box
  that holds the cued key verifies the players' passes and reports the finished match to cued.

## 7. Testing

- **Unit tests:** build passes with HMAC-SHA256 exactly as `tests/cued.test.ts` does, and check every
  claim, malformed passes and expiry.
- **In a browser:** open `https://<your-game>/#cued=<test pass>` directly. You should see the badge, and
  the fragment should be gone from the address bar. Then navigate inside the game: the badge should stay.
- **In a frame:** put the iframe snippet from section 3 into a local HTML file and open it. Check that
  pointer lock, fullscreen, audio and GameHub all work inside the sandbox.
- **Without a pass:** the game must behave exactly as before.
