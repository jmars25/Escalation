// Core data model. Everything the game (and later, the LLM agents) reasons over
// lives in GameState — one serializable object. Keep it that way.

export type FactionType = 'player' | 'ally' | 'rival' | 'neutral'

/** Axial hex coordinate. See hexUtils.ts for geometry. */
export interface Hex {
  q: number
  r: number
}

/** String key for a hex, e.g. "2,-1". Used to index maps. */
export type HexKey = string

export type Terrain = 'plains' | 'mountain' | 'sea' | 'island'

export interface Tile {
  hex: Hex
  owner: FactionId | null
  /** True when this tile borders a tile owned by a *different bloc* (cross-alignment frontier). */
  contested: boolean
  /** Factions that politically claim this hex (a flashpoint). Distinct from owner. */
  disputedBy?: FactionId[]
  /** A demilitarized zone — claiming it (moving troops in) is a major political act. */
  dmz?: boolean
  terrain: Terrain
}

export type FactionId = string

/** Which side of the crisis a faction stands on. */
export type Alignment = 'coalition' | 'bloc' | 'neutral'

export interface Faction {
  id: FactionId
  name: string
  type: FactionType
  /** Player + its allies = coalition; rival + its satellites = bloc. */
  alignment: Alignment
  color: string
  /** Hex of this faction's capital (derived: the most central tile it owns). */
  capital: Hex
  // --- Political state the LLM reads (it decides reactions; these are inputs, not rules) ---
  /** Domestic backing for this government, 0..100. Hits 0 → regime falls (game over). */
  support: number
  /** Economy/trade barometer, 0..100. Reflects city integrity AND open trade links;
   *  only purpose is keeping the population and allies content. NOT a procurement resource. */
  market: number
  /** Economic size — how much this nation is worth as a trade partner. Big nations
   *  (more cities) are worth more, so losing trade with them hurts more. */
  tradeWeight: number
  /** Relations toward the player, -100 (hostile) .. +100 (aligned). */
  disposition: number
  procurement: ProcurementState
  // --- Prose that will seed the Phase 3 Government/Population agents. ---
  doctrine: string
  redLines: string[]
  objectives: string[]
}

export type ProcurementPolicy = 'civilian' | 'contracts' | 'emergency' | 'draft'
export type ProcurementBurden = 'low' | 'standard' | 'high' | 'crisis'
export type ProcurementProjectType = 'army_group' | 'missile_battery' | 'naval_group' | 'air_base' | 'naval_base'
export type AidPackageType = 'economic' | 'arms'

export interface ProcurementProject {
  type: ProcurementProjectType
  progress: number
}

export interface ProcurementState {
  policy: ProcurementPolicy
  burden: ProcurementBurden
  project?: ProcurementProject
  aidBoost: number
  aidBoostTurns: number
}

// --- Installations: fixed structures that sit on a tile and never move. -------
// Air power is modeled here, not as a unit: aircraft live at an air base and are
// only ever a strike-package option (Phase 2) — they never occupy a token on the map.
export type InstallationType = 'city' | 'army_base' | 'air_base' | 'naval_base' | 'radar'

export interface Installation {
  id: string
  owner: FactionId
  type: InstallationType
  hex: Hex
  /** Structural health 0–100. Cities feed the market; bases take a pounding before
   *  they fall. Destroyed (removed) at 0 — except cities, which persist at low integrity. */
  integrity: number
  /** Air bases: strike sorties available. 2 = one full or two limited air strikes;
   *  refreshes at the owner's turn. */
  charges?: number
  maxCharges?: number
}

// --- Forces: mobile assets you forward-deploy. Unlimited stacking per tile. ----
//   army_group      — moves over land; can occupy/hold ground.
//   naval_group     — moves over sea; forward-deploys for strike packages.
//   missile_battery — drone/missile deployment; launches strikes but CANNOT occupy a tile.
export type ForceType = 'army_group' | 'naval_group' | 'missile_battery'

export interface Force {
  id: string
  owner: FactionId
  type: ForceType
  /** Current health (HP). Depletes from strikes and melee; destroyed at <=0. */
  health: number
  /** Max health, for the melee health factor and UI. */
  maxHealth: number
  /** Combat strength (power) used in melee rolls. Higher = hits harder, takes less.
   *  Per-nation for armies (Aurelia & Kazrek field stronger armies). */
  strength: number
  hex: Hex
  /** One action per turn: a unit can deploy, attack, claim, or strike.
   *  Reset to false when its faction's turn begins. */
  acted: boolean
  /** Strike platforms (naval, missile): charges available. 2 = one full or two limited
   *  strikes; restocks to max when on/adjacent a friendly base. Undefined = can't strike. */
  charges?: number
  maxCharges?: number
}

export type EventKind = 'system' | 'player' | 'escalation' | 'dispatch'

export interface GameEvent {
  turn: number
  kind: EventKind
  /** Faction responsible, if any. */
  faction?: FactionId
  text: string
}

export interface GameState {
  /** Round number. Increments after every faction has taken its turn. */
  turn: number
  /** Turn order (faction ids). */
  order: FactionId[]
  /** Index into `order` — whose turn it currently is. */
  turnIndex: number
  /** 0 (calm) .. 100 (catastrophe). The spine of the game. */
  escalation: number
  factions: Record<FactionId, Faction>
  tiles: Record<HexKey, Tile>
  installations: Installation[]
  forces: Force[]
  /** Severed trade links, each a sorted "a|b" faction-pair key. Absent = trading. */
  embargoes: string[]
  /** Which faction imposed each embargo. Only that faction can restore the link. */
  embargoedBy: Record<string, FactionId>
  log: GameEvent[]
  /** Set when a government's support collapses — the game is over. */
  regimeFallen?: FactionId
}
