// net.ts - Arena netcode on top of GameHub. No DOM, so it runs in the browser and in Node tests.
//
// Pattern: HOST-AUTHORITATIVE.
//   - the host runs the simulation at 20 Hz, broadcasts one delta per tick and a full snapshot every 2 s
//   - other players only send their input (an "intent") to the host and mirror the world from the deltas
//   - if the host leaves, GameHub promotes the next player; because every client already holds a full
//     copy of the world, the new host simply continues the simulation from where it was
import { connect } from "../../client/gamehub.ts";
import type { GameHub, RoomSummary } from "../../client/gamehub.ts";
import { addPlayer, applyDelta, createWorld, NO_INPUT, removePlayer, step } from "./game.ts";
import type { Input, Intent, Player, World, WorldDelta } from "./game.ts";

export const TICK_MS = 50;          // 20 Hz simulation and network rate
export const SNAPSHOT_EVERY = 40;   // full state every 40 ticks (2 s) keeps the server's late-joiner history short

export type SessionOptions = { url?: string; app: string; appKey?: string; access?: boolean; name: string };

export class ArenaSession {
  readonly hub: GameHub<World, WorldDelta, Intent>;
  world: World | null = null;
  /** Called after every world change - hook rendering or UI updates here. */
  onChange: () => void = () => {};

  private inputs = new Map<number, Input>();
  private myInput: Input = { ...NO_INPUT };
  private timer: ReturnType<typeof setInterval> | null = null;
  private added: Player[] = [];
  private removed: number[] = [];
  private sinceSnapshot = 0;

  constructor(options: SessionOptions) {
    this.hub = connect<World, WorldDelta, Intent>(options);
    const hub = this.hub;

    hub.on("joined", () => {
      if (hub.isHost) {
        // We created the room (or re-entered an empty one): start a fresh world.
        this.world = createWorld();
        for (const p of hub.players) addPlayer(this.world, p.id, p.name);
        this.startHosting();
      } else {
        this.sendInput();
      }
    });
    hub.on("state", (world) => { if (!hub.isHost) { this.world = world; this.onChange(); } });
    hub.on("delta", (d) => { if (!hub.isHost && this.world) { applyDelta(this.world, d); this.onChange(); } });
    hub.on("msg", (intent, from) => {
      if (hub.isHost && intent?.type === "input") this.inputs.set(from, intent.input);
    });
    hub.on("player+", (p) => {
      if (hub.isHost && this.world) this.added.push(addPlayer(this.world, p.id, p.name));
    });
    hub.on("player-", (id) => {
      this.inputs.delete(id);
      if (hub.isHost && this.world) { removePlayer(this.world, id); this.removed.push(id); }
    });
    hub.on("host", (id) => {
      if (id === hub.you) this.takeOverAsHost();
      else { this.stopHosting(); this.sendInput(); }
    });
    hub.on("need-snapshot", () => { if (hub.isHost && this.world) this.snapshot(); });
  }

  get ready() { return this.hub.ready; }
  get isHost() { return this.hub.isHost; }
  get roomCode() { return this.hub.room?.id ?? null; }

  create(name: string): Promise<RoomSummary> {
    return this.hub.create({ name, maxPlayers: 8, meta: { mode: "arena" } });
  }
  join(code: string): Promise<RoomSummary> { return this.hub.join(code); }
  watchLobby(onRooms: (rooms: RoomSummary[]) => void): () => void { return this.hub.watchLobby(onRooms); }

  /** Feed the local player's controls. Cheap to call every frame: only changes are sent. */
  setInput(input: Input): void {
    const m = this.myInput;
    if (m.up === input.up && m.down === input.down && m.left === input.left && m.right === input.right) return;
    this.myInput = { ...input };
    this.sendInput();
  }

  close(): void { this.stopHosting(); this.hub.close(); }

  private sendInput(): void {
    const hub = this.hub;
    if (hub.you === null) return;
    if (hub.isHost) this.inputs.set(hub.you, this.myInput);
    else if (hub.host !== null) hub.send({ type: "input", input: this.myInput }, hub.host);
  }

  private takeOverAsHost(): void {
    const hub = this.hub;
    // Continue from the replicated world; reconcile it with who is actually in the room now.
    if (!this.world) this.world = createWorld();
    const present = new Set(hub.players.map((p) => String(p.id)));
    for (const key of Object.keys(this.world.players)) if (!present.has(key)) removePlayer(this.world, Number(key));
    for (const p of hub.players) if (!this.world.players[String(p.id)]) addPlayer(this.world, p.id, p.name);
    this.inputs.clear();
    this.startHosting();
  }

  private startHosting(): void {
    if (this.timer) return;
    this.sendInput();
    this.snapshot();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopHosting(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private snapshot(): void {
    if (!this.world) return;
    this.hub.setState(this.world);
    this.sinceSnapshot = 0;
    this.added = [];
    this.removed = [];
  }

  private tick(): void {
    if (!this.world) return;
    const delta = step(this.world, this.inputs, TICK_MS / 1000);
    if (this.added.length) { delta.added = this.added; this.added = []; }
    if (this.removed.length) { delta.removed = this.removed; this.removed = []; }
    this.hub.sendDelta(delta);
    if (++this.sinceSnapshot >= SNAPSHOT_EVERY) this.snapshot();
    this.onChange();
  }
}
