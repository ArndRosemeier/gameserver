// registry.ts - reads the apps.futuremagic.de registry (apps.json) and asks GameHub for live rooms.
//
// A game appears in the lobby only if its apps.json entry has a `gamehub` block (see docs/LOBBY.md).

export type GameHubListing = {
  /** GameHub app id, as registered with `npm run apps -- add <id>`. */
  app: string;
  /** "key" (default) or "cloudflare". */
  access?: "key" | "cloudflare";
  /** App key for key-mode apps. Not a secret: it is in the game's bundle anyway. */
  key?: string;
  /** Room link template, resolved against the game's path. `{code}` becomes the room code. */
  join?: string;
  /** Optional custom HTML card, resolved against the registry URL. Shown in a sandboxed iframe. */
  html?: string;
  /** Height of the custom HTML card in CSS pixels. Default 220. */
  htmlHeight?: number;
  /** GameHub server root. Default https://games.futuremagic.de */
  server?: string;
};

export type RegistryEntry = {
  slug: string;
  title: string;
  path: string;
  tagline?: string;
  tags?: string[];
  screenshot?: string;
  updatedAt?: string;
  gamehub?: GameHubListing;
};

export type LobbyGame = RegistryEntry & { gamehub: GameHubListing };

export type RoomSummary = {
  id: string;
  name: string;
  public: boolean;
  players: number;
  maxPlayers: number;
  meta: unknown;
  host: number;
  createdAt: number;
};

const DEFAULT_SERVER = "https://games.futuremagic.de";

/** Loads the registry and keeps only valid, opted-in games, sorted by title. */
export async function loadGames(registryUrl: string): Promise<LobbyGame[]> {
  const r = await fetch(registryUrl, { cache: "no-store" });
  if (!r.ok) throw new Error(`registry HTTP ${r.status}`);
  const data = (await r.json()) as { apps?: RegistryEntry[] };
  const base = new URL(registryUrl, location.href);
  return (data.apps ?? [])
    .filter((e): e is LobbyGame => isListing(e.gamehub) && typeof e.path === "string")
    .flatMap((e) => {
      try {
        // Resolve relative paths once, so the rest of the page only sees absolute URLs.
        const path = new URL(e.path, base);
        if (!/^https?:$/.test(path.protocol)) return []; // a game must live at an http(s) URL
        const html = e.gamehub.html ? new URL(e.gamehub.html, base).href : undefined;
        const screenshot = e.screenshot ? new URL(e.screenshot, base).href : undefined;
        return [{ ...e, path: path.href, screenshot, gamehub: { ...e.gamehub, html } }];
      } catch {
        return []; // one broken entry must not hide the others
      }
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function isListing(g: unknown): g is GameHubListing {
  return !!g && typeof g === "object" && typeof (g as GameHubListing).app === "string" && (g as GameHubListing).app !== "";
}

/** Public rooms with at least one player, as GameHub's HTTP endpoint returns them. */
export async function fetchRooms(g: GameHubListing): Promise<RoomSummary[]> {
  const cloudflare = g.access === "cloudflare";
  const root = (g.server ?? DEFAULT_SERVER).replace(/\/+$/, "") + (cloudflare ? "/access" : "");
  const headers: Record<string, string> = {};
  if (!cloudflare && g.key) headers["x-app-key"] = g.key;
  const r = await fetch(`${root}/v1/apps/${encodeURIComponent(g.app)}/rooms`, {
    headers,
    credentials: cloudflare ? "include" : "omit",
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`rooms HTTP ${r.status}`);
  return ((await r.json()) as { rooms: RoomSummary[] }).rooms;
}

/** Link for a room: the game's join template, or the game itself if it has none. */
export function roomUrl(game: LobbyGame, code: string): string {
  const t = game.gamehub.join;
  if (!t) return game.path;
  return new URL(t.replaceAll("{code}", encodeURIComponent(code)), game.path).href;
}
