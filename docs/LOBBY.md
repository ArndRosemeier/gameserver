# The GameHub lobby

`https://apps.futuremagic.de/lobby/` lists every multiplayer game that is running right now. Rooms are
grouped under their game, each room has a Join link, and each game can show its own custom HTML card
(screenshots, news, rules, anything).

The lobby does not have its own list of games. It reads the site registry
**`https://apps.futuremagic.de/apps.json`**, the same file the site's front page uses, and shows only the
entries that have a **`gamehub` block**. Entries without that block, such as Arena, which is only a
proof of concept, are ignored.

This document is the contract for whoever writes `apps.json`, meaning the agents that announce games on
the box.

---

## Adding a game to the lobby

Add a `gamehub` object to the game's existing entry in `apps.json`. Leave the other fields as they are:

```json
{
  "slug": "Tank",
  "title": "Tank",
  "path": "https://apps.futuremagic.de/Tank/",
  "tagline": "Little tanks, big explosions.",
  "screenshot": "/shots/Tank.png",
  "gamehub": {
    "app": "tank",
    "key": "ghk_tank_...",
    "join": "?room={code}",
    "html": "/lobby-cards/Tank.html",
    "htmlHeight": 240
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `app` | **yes** | The GameHub app id, the `<id>` from `npm run apps -- add <id>`. |
| `access` | no | `"key"` (default) or `"cloudflare"`, matching how the app was registered. |
| `key` | for `key` apps | The app key (`ghk_…`). It is **not a secret**: the game ships it in its bundle anyway. |
| `join` | recommended | A link template for one room. `{code}` is replaced by the 6-character room code, and the result is resolved against the game's `path`. Examples: `"?room={code}"`, `"#join={code}"`, `"play/{code}"`. Without it, Join opens the game's start page. |
| `html` | no | URL of the custom HTML card. A relative URL is resolved against `apps.json`. Without it, the lobby shows the entry's `screenshot` instead. |
| `htmlHeight` | no | Height of the card in CSS pixels. Default 220, clamped to 80–800. |
| `server` | no | GameHub root URL. Default `https://games.futuremagic.de`. |

To remove a game from the lobby, delete its `gamehub` block. The lobby rereads `apps.json` on every page
load, so a change is visible after a reload, with no build or deploy.

### What the game itself must do

A `gamehub` block is a promise that the game supports the lobby. The game must:

1. **Use GameHub rooms**, created with `hub.create({ name, public: true, ... })`. The lobby only sees
   **public** rooms that have **at least one player**, so private rooms never show up.
2. **Give rooms a readable name.** The `name` is what the lobby shows.
3. **Join a room from its URL.** When the page is opened through the `join` link, the game should read
   the code and call `hub.join(code)` without asking the player first. For `"join": "?room={code}"`:

   ```ts
   const code = new URLSearchParams(location.search).get("room");
   await hub.ready;
   if (code) await hub.join(code);       // straight into the room
   else showOwnLobby();                  // normal start screen
   ```

   If the room is gone by then (`no_such_room` or `room_full`), fall back to the normal start screen.

### The custom HTML card

The card is a normal HTML page, but it is shown in a **sandboxed iframe**
(`sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"`):

- Scripts run, and links open in a new tab. Use `target="_blank"` on links.
- The card cannot read or change the lobby, its cookies or its storage, and its CSS cannot leak out.
- The card is not resized to fit its content, so set `htmlHeight` to match your layout.
- Make it self-contained: inline styles, images by absolute URL. The background behind it is dark brown
  (`#1a120c`), so a dark card with light text fits best. Keep it about 420 px wide or wider; on phones
  the card is full width.

Host the card next to the game or in a shared folder on the site, for example `/lobby-cards/<slug>.html`.

---

## Who sees what

| App access mode | Lobby shows its rooms to |
|---|---|
| `key` | everyone |
| `cloudflare` | only visitors who are logged in through Cloudflare Access (`games.futuremagic.de/access/`); everyone else sees "offline" |

The lobby polls each game's `GET /v1/apps/{app}/rooms` every 5 seconds while the tab is visible. It
stops polling in background tabs. The request comes from `https://apps.futuremagic.de`, so GameHub
must allow that origin for CORS. Games already make this request through `hub.listRooms()`.

## Building and deploying the lobby

```bash
npm run dev:lobby      # http://localhost:5175/ — proxies /apps.json and /shots/ to the live site
npm run build:lobby    # → dist-lobby/, with relative asset URLs
```

Copy `dist-lobby/` to the site's `lobby/` folder, so it is served at `https://apps.futuremagic.de/lobby/`.
The lobby reads `/apps.json` from its own origin. To try a draft registry before publishing it, open
`/lobby/?registry=<url-of-draft.json>`. You can also set `VITE_LOBBY_REGISTRY` at build time.

Optionally, list the lobby itself in `apps.json` **without** a `gamehub` block, so it appears on the
front page:

```json
{ "slug": "lobby", "title": "Lobby", "path": "https://apps.futuremagic.de/lobby/",
  "tagline": "Multiplayer games running right now. Pick a room and join.", "tags": ["games", "multiplayer"] }
```

## Background image

`lobby/assets/background.webp` was generated with OpenRouter (`meta/muse-image`, 16:9) and saved as
1920×1280 WebP at quality 70. Prompt:

> Wide atmospheric painted fantasy backdrop for a game lobby: a grand candlelit tavern hall at dusk seen
> from a balcony, long wooden tables with glowing game boards, maps and tokens, warm amber and copper
> light, deep brown shadows, painterly oil style, soft depth of field, dark vignette edges, calm empty
> center area for text overlay, no people in the foreground, no text, no letters
