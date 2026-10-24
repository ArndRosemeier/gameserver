// game.ts - the Arena simulation. Pure TypeScript: no network, no DOM.
// Only the HOST runs step(); everyone else mirrors the world with applyDelta().

export const WIDTH = 800;
export const HEIGHT = 500;
export const PLAYER_RADIUS = 14;
export const COIN_RADIUS = 10;
const SPEED = 220; // px per second

export type Input = { up: boolean; down: boolean; left: boolean; right: boolean };
export const NO_INPUT: Input = { up: false, down: false, left: false, right: false };

export type Player = { id: number; name: string; x: number; y: number; score: number; color: string };

/** Full state - what the host sends with setState(). Player keys are ids as strings (JSON). */
export type World = {
  tick: number;
  players: Record<string, Player>;
  coin: { x: number; y: number };
};

/** One tick's change - what the host sends with sendDelta(). Kept small: [x, y, score] per player. */
export type WorldDelta = {
  tick: number;
  pos: Record<string, [number, number, number]>;
  coin?: { x: number; y: number };
  added?: Player[];
  removed?: number[];
};

/** What a non-host player sends to the host. */
export type Intent = { type: "input"; input: Input };

const COLORS = ["#ff6b6b", "#4dabf7", "#51cf66", "#fcc419", "#cc5de8", "#ff922b", "#20c997", "#f06595"];
const round1 = (n: number) => Math.round(n * 10) / 10;
const randomCoin = () => ({
  x: round1(COIN_RADIUS + Math.random() * (WIDTH - 2 * COIN_RADIUS)),
  y: round1(COIN_RADIUS + Math.random() * (HEIGHT - 2 * COIN_RADIUS)),
});

export function createWorld(): World {
  return { tick: 0, players: {}, coin: randomCoin() };
}

export function addPlayer(world: World, id: number, name: string): Player {
  const p: Player = {
    id, name,
    x: round1(PLAYER_RADIUS + Math.random() * (WIDTH - 2 * PLAYER_RADIUS)),
    y: round1(PLAYER_RADIUS + Math.random() * (HEIGHT - 2 * PLAYER_RADIUS)),
    score: 0,
    color: COLORS[id % COLORS.length],
  };
  world.players[String(id)] = p;
  return p;
}

export function removePlayer(world: World, id: number): void {
  delete world.players[String(id)];
}

/** Advance the world by dt seconds (host only). Mutates the world and returns the delta to broadcast. */
export function step(world: World, inputs: Map<number, Input>, dt: number): WorldDelta {
  world.tick++;
  const delta: WorldDelta = { tick: world.tick, pos: {} };
  for (const key of Object.keys(world.players)) {
    const p = world.players[key];
    const input = inputs.get(p.id) ?? NO_INPUT;
    let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    if (dx && dy) { dx *= Math.SQRT1_2; dy *= Math.SQRT1_2; }
    p.x = round1(Math.min(WIDTH - PLAYER_RADIUS, Math.max(PLAYER_RADIUS, p.x + dx * SPEED * dt)));
    p.y = round1(Math.min(HEIGHT - PLAYER_RADIUS, Math.max(PLAYER_RADIUS, p.y + dy * SPEED * dt)));
    if (Math.hypot(p.x - world.coin.x, p.y - world.coin.y) < PLAYER_RADIUS + COIN_RADIUS) {
      p.score++;
      world.coin = randomCoin();
      delta.coin = world.coin;
    }
    delta.pos[key] = [p.x, p.y, p.score];
  }
  return delta;
}

/** Mirror one host delta (everyone except the host). */
export function applyDelta(world: World, d: WorldDelta): void {
  world.tick = d.tick;
  for (const p of d.added ?? []) world.players[String(p.id)] = { ...p };
  for (const id of d.removed ?? []) delete world.players[String(id)];
  for (const key of Object.keys(d.pos)) {
    const p = world.players[key];
    if (!p) continue;
    [p.x, p.y, p.score] = d.pos[key];
  }
  if (d.coin) world.coin = d.coin;
}
