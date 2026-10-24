/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Registry URL. Default /apps.json (same origin as the lobby on apps.futuremagic.de). */
  readonly VITE_LOBBY_REGISTRY?: string;
}
