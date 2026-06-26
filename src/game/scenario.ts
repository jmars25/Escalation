// The fixed cast and an *authored* map (not procedural) so the geography is
// deliberate: two landmasses split by a wide strait, a coalition on the west, the
// rival's bloc on the east, neutrals scattered, two stranded enclaves making
// trouble, and disputed flashpoint hexes. Edit the MAP grid to reshape the world.

import type {
  Faction, FactionId, Force, ForceType, GameState, Hex, Installation, InstallationType, Tile,
} from './types'
import { distance, key, neighbors } from './hexUtils'

type FactionDef = Omit<Faction, 'capital' | 'market' | 'tradeWeight' | 'procurement'>

// Bases take a pounding; cities feed the market; radar is soft.
const BASE_INTEGRITY: Record<InstallationType, number> = {
  city: 100, naval_base: 110, army_base: 95, air_base: 90, radar: 55,
}
// Force health (HP). Civ-style — strikes/melee chip it over rounds, rarely a one-shot.
// Marines are a lighter army group: less HP, less power.
const FORCE_HEALTH: Record<ForceType, number> = {
  army_group: 40, marine: 30, naval_group: 55, missile_battery: 28,
}
// Combat strength (power) for melee rolls. Per-nation army overrides below.
const FORCE_STRENGTH: Record<ForceType, number> = {
  army_group: 7, marine: 5, naval_group: 9, missile_battery: 4,
}
// Aurelia and Kazrek field markedly stronger armies than everyone else.
const ARMY_STRENGTH: Record<FactionId, number> = { aurelia: 10, kazrek: 10 }

// The crisis: a DEMOCRATIC bloc (cool colors, led by Aurelia) versus a THEOCRATIC
// bloc (warm colors, led by Volkaria, seat of the Sanctified Creed). Gray = neutral.
export const FACTIONS: FactionDef[] = [
  // --- Democratic bloc (you + allies) ---
  { id: 'aurelia', name: 'Aurelia', type: 'player', alignment: 'coalition', color: '#3b82f6',
    doctrine: 'The leading liberal democracy and anchor of the democratic bloc. Prefers deterrence and law to force; answerable to voters and a free press.',
    redLines: ['Any strike on Aurelian soil', 'Collapse of an allied democracy'],
    objectives: ['Stop the theocratic bloc revising borders by force', 'Hold the democratic coalition together'],
    support: 72, disposition: 100 },
  { id: 'mirelle', name: 'Mirelle', type: 'ally', alignment: 'coalition', color: '#38bdf8',
    doctrine: 'A backline allied democracy that tries to avoid conflict whenever possible without becoming apathetic toward Aurelia. It favors support, diplomacy, and rear-area assistance over direct exposure.',
    redLines: ['Being dragged into direct war without consultation'], objectives: ['Support Aurelia while avoiding escalation', 'Keep the coalition engaged without becoming a battlefield'],
    support: 60, disposition: 70 },
  { id: 'solvenn', name: 'Solvenn', type: 'ally', alignment: 'coalition', color: '#22d3ee',
    doctrine: 'A strong supporter of the Aurelian bloc that sees the territory between Solvenn and the Volkarian bloc as a vital strategic buffer. It backs Aurelia firmly and wants the buffer states kept out of Volkarian reach.',
    redLines: ['Direct attack on its territory', 'Volkarian control of the buffer zone'], objectives: ['Keep a secure buffer between Solvenn and Volkaria', 'Back Aurelia as the bloc leader', 'avoid strikes on own territory'],
    support: 66, disposition: 78 },
  { id: 'tamarisk', name: 'Tamarisk', type: 'ally', alignment: 'coalition', color: '#2dd4bf',
    doctrine: 'A hawkish but vulnerable democracy stranded as an enclave on the theocratic landmass and dependent on Aurelian support. The surrounding deployments are a longstanding armed status quo, not a new provocation by themselves. It wants to prove resolve, but knows that attacking neutrals or launching offensives without clear coalition backing, a direct threat, or a plausible path to victory could leave it isolated and destroyed. Coalition action against Kazrek may make Tamarisk a target for limited coercive strikes meant to pressure Aurelia.',
    redLines: ['Being cut off or overrun', 'Being abandoned by Aurelia after a crisis it did not choose'], objectives: ['Hold the enclave', 'Force Aurelia to guarantee its security', 'Avoid reckless attacks that unite neighbors against it'],
    support: 64, disposition: 75 },

  // --- Theocratic bloc (the rival + its clients) ---
  { id: 'volkaria', name: 'Volkaria', type: 'rival', alignment: 'bloc', color: '#ef4444',
    doctrine: 'The theocratic great power and seat of the Sanctified Creed. Believes its faith entitles it to revise the godless borders. Opposed to Aurelia but not yet at open war. Existing forces around Tamarisk are a longstanding armed status quo, not a reason to fire by themselves; after coalition military action against Kazrek, Volkaria may use one limited strike on a Tamarisk military target as controlled pressure on Aurelia.',
    redLines: ['Foreign troops on Volkarian soil', 'Desecration of a holy city'],
    objectives: ['Advance the Creed’s claims', 'Split the democratic coalition', 'Try and preserve kazrek without fully commiting to war against Aurelia', 'Use controlled pressure on Tamarisk when needed to impose costs for attacks on Kazrek', 'Signal to rest of world that it will protect faithful'],
    support: 80, disposition: -40 },
  { id: 'drovenia', name: 'Drovenia', type: 'ally', alignment: 'bloc', color: '#f97316',
    doctrine: 'A militarized dictatorship built around regime survival, internal control, and coercive force. It is heavily armed, paranoid, and willing to use crises abroad to reinforce obedience at home. Existing forces near Tamarisk are not a new provocation; after coalition military action against Kazrek, Drovenia may join a coordinated limited strike on Tamarisk military assets to pressure Aurelia, but should not start an unrelated local war.',
    redLines: ['Threats to regime survival', 'Foreign-backed unrest'], objectives: ['Preserve the dictatorship', 'Use force to secure the Esquana-Drovenia contested territory when politically justified', 'Support coordinated bloc pressure when Kazrek is attacked', 'Signal strength internationally'],
    support: 70, disposition: -55 },
  { id: 'kazrek', name: 'Kazrek', type: 'ally', alignment: 'bloc', color: '#f43f5e',
    doctrine: 'A radical theocracy and zealous client of the Creed, stranded as an enclave inside the democratic landmass. It holds a religious claim to the neighboring demilitarized zone and is fervent enough to seize it; backing it down is hard, its people rally to defiance, and it should resist ceasefires unless battlefield losses, isolation, or regime danger make a pause necessary.',
    redLines: ['Surrendering its claim to the holy ground', 'Coalition forces encircling the enclave'],
    objectives: ['Seize the DMZ it claims as sacred', 'Invite Volkaria in to “protect” the faithful', 'escalate the situation in hopes of getting Volkaria to enter in your defense'],
    support: 88, disposition: -45 },

  // --- Neutrals ---
  { id: 'khorul', name: 'Khorul', type: 'neutral', alignment: 'neutral', color: '#a8a29e',
    doctrine: 'A pivotal religous neutral on the democratic coast, courted by both sides. Fears the radical kazrek regime but has sympathy towards its population and religious claims',
    redLines: ['Violation of its neutrality'], objectives: ['Stay neutral; extract concessions from both sides'],
    support: 55, disposition: 0 },
  { id: 'esquana', name: 'Esquana', type: 'neutral', alignment: 'neutral', color: '#cbd5e1',
    doctrine: 'A wealthy religious monarchy that remains neutral because it distrusts Volkaria’s radicalism as much as it distrusts democratic pressure. It has a contested claim against Drovenia and wants to keep Drovenia out of it.',
    redLines: ['Drovenian control of the contested territory', 'Threats to the monarchy or holy institutions'], objectives: ['Protect royal neutrality', 'deny disputed territory to Drovenia, keep it as a buffer'],
    support: 58, disposition: 0 },
  { id: 'ostara', name: 'Ostara', type: 'neutral', alignment: 'neutral', color: '#9ca3af',
    doctrine: 'A deeply neutral southern secular state with no stake in the rivalry. Trades with all, allies with none. Feels war is bad for buisness.',
    redLines: ['Any foreign force entering its territory'], objectives: ['Remain strictly non-aligned', 'Try and calm down regional tensions', 'Signal to people and world it is able to diplomatically work with both blocs'],
    support: 60, disposition: 0 },
]

// Each entry is one hex tile. r = row (0 = top), q = column on a skewed axis
// (within a row, q+1 moves right one hex). Omit `sea` for normal land.
// To add a tile: copy a neighbor's {q,r} and adjust q±1 (same row) or r+1 (next row).
// To move a tile: change its q/r values here.
type TileDef = { q: number; r: number; owner?: FactionId; sea?: true; island?: true; strait?: true; disputed?: FactionId[]; dmz?: true }

const TILES: TileDef[] = [
  // r=0 — northern edge
  { q: 1,  r: 0, owner: 'mirelle'  },
  { q: 2,  r: 0, owner: 'mirelle'  },
  { q: 3,  r: 0, owner: 'aurelia'  },
  { q: 4,  r: 0, owner: 'aurelia'  },
  { q: 5,  r: 0, owner: 'khorul'   },
  { q: 6,  r: 0, sea: true, strait: true },
  { q: 7,  r: 0, sea: true, strait: true },
  { q: 8,  r: 0, owner: 'drovenia' },
  { q: 9,  r: 0, owner: 'drovenia' },
  { q: 10, r: 0, owner: 'volkaria' },
  { q: 11, r: 0, owner: 'volkaria' },

  // r=1
  { q: 0,  r: 1, sea: true },
  { q: 1,  r: 1, owner: 'mirelle'  },
  { q: 2,  r: 1, owner: 'mirelle'  },
  { q: 3,  r: 1, owner: 'aurelia'  },
  { q: 4,  r: 1, owner: 'aurelia'  },
  { q: 5,  r: 1, owner: 'khorul'   },
  { q: 6,  r: 1, sea: true, strait: true },
  { q: 7,  r: 1, sea: true, strait: true },
  { q: 8,  r: 1, disputed: ['drovenia', 'esquana'] }, // drovenia/esquana flashpoint
  { q: 9,  r: 1, owner: 'drovenia' },
  { q: 10, r: 1, owner: 'volkaria' },
  { q: 11, r: 1, owner: 'volkaria' },
  { q: 12, r: 1, owner: 'volkaria' },

  // r=2
  { q: -1, r: 2, sea: true },
  { q: 0,  r: 2, owner: 'mirelle'  },
  { q: 1,  r: 2, owner: 'aurelia'  },
  { q: 2,  r: 2, owner: 'aurelia'  },
  { q: 3,  r: 2, owner: 'aurelia'  },
  { q: 4,  r: 2, owner: 'khorul'   },
  { q: 5,  r: 2, sea: true, strait: true },
  { q: 6,  r: 2, sea: true, strait: true },
  { q: 7,  r: 2, owner: 'esquana'  },
  { q: 8,  r: 2, owner: 'drovenia' },
  { q: 9,  r: 2, owner: 'drovenia' },
  { q: 10, r: 2, owner: 'volkaria' },
  { q: 11, r: 2, owner: 'volkaria' },

  // r=3
  { q: -1, r: 3, sea: true },
  { q: 0,  r: 3, owner: 'aurelia'  },
  { q: 1,  r: 3, owner: 'aurelia'  },
  { q: 2,  r: 3, owner: 'aurelia'  },
  { q: 3,  r: 3, owner: 'kazrek'   },
  { q: 4,  r: 3, owner: 'khorul'   },
  { q: 5,  r: 3, sea: true, strait: true },
  { q: 6,  r: 3, sea: true, strait: true },
  { q: 7,  r: 3, owner: 'esquana'  },
  { q: 8,  r: 3, owner: 'tamarisk' },
  { q: 9,  r: 3, owner: 'drovenia' },
  { q: 10, r: 3, owner: 'volkaria' },
  { q: 11, r: 3, owner: 'volkaria' },

  // r=4
  { q: -2, r: 4, sea: true },
  { q: -1, r: 4, owner: 'aurelia'  },
  { q: 0,  r: 4, owner: 'aurelia'  },
  { q: 1,  r: 4, owner: 'kazrek'   },
  { q: 2,  r: 4, owner: 'kazrek'   },
  { q: 3,  r: 4, owner: 'khorul'   },
  { q: 4,  r: 4, sea: true, strait: true },
  { q: 5,  r: 4, sea: true, strait: true },
  { q: 6,  r: 4, owner: 'esquana'  },
  { q: 7,  r: 4, owner: 'tamarisk' },
  { q: 8,  r: 4, owner: 'volkaria' },
  { q: 9,  r: 4, owner: 'volkaria' },
  { q: 10, r: 4, owner: 'volkaria' },

  // r=5
  { q: -2, r: 5, sea: true },
  { q: -1, r: 5, owner: 'solvenn'  },
  { q: 0,  r: 5, owner: 'aurelia'  },
  { q: 1,  r: 5, owner: 'aurelia'  },
  { q: 2,  r: 5, owner: 'kazrek'   },
  { q: 3,  r: 5, sea: true, strait: true },
  { q: 4,  r: 5, sea: true, strait: true },
  { q: 5,  r: 5, sea: true, strait: true },
  { q: 6,  r: 5, owner: 'esquana'  },
  { q: 7,  r: 5, owner: 'tamarisk' },
  { q: 8,  r: 5, owner: 'volkaria' },
  { q: 9,  r: 5, owner: 'volkaria' },
  { q: 10, r: 5, owner: 'volkaria' },

  // r=6
  { q: -3, r: 6, sea: true },
  { q: -2, r: 6, owner: 'solvenn'  },
  { q: -1, r: 6, owner: 'solvenn'  },
  { q: 0,  r: 6, owner: 'aurelia'  },
  { q: 1,  r: 6, disputed: ['kazrek', 'aurelia'], dmz: true }, // DMZ flashpoint
  { q: 2,  r: 6, sea: true, strait: true },
  { q: 3,  r: 6, island: true, strait: true, disputed: ['volkaria', 'aurelia'] },
  { q: 4,  r: 6, sea: true, strait: true },
  { q: 5,  r: 6, owner: 'esquana'  },
  { q: 6,  r: 6, owner: 'tamarisk' },
  { q: 7,  r: 6, owner: 'volkaria' },
  { q: 8,  r: 6, owner: 'volkaria' },
  { q: 9,  r: 6, sea: true },

  // r=7
  { q: -3, r: 7, sea: true },
  { q: -2, r: 7, owner: 'solvenn'  },
  { q: -1, r: 7, owner: 'solvenn'  },
  { q: 0,  r: 7, owner: 'aurelia'  },
  { q: 1,  r: 7, owner: 'aurelia'  },
  { q: 2,  r: 7, sea: true, strait: true },
  { q: 3,  r: 7, sea: true, strait: true },
  { q: 4,  r: 7, sea: true, strait: true },
  { q: 5,  r: 7, owner: 'esquana'  },
  { q: 6,  r: 7, owner: 'volkaria' },
  { q: 7,  r: 7, owner: 'volkaria' },
  { q: 8,  r: 7, owner: 'volkaria' },
  { q: 9,  r: 7, sea: true },

  // r=8 — southern isthmus where the two landmasses meet
  { q: -4, r: 8, sea: true },
  { q: -3, r: 8, sea: true },
  { q: -2, r: 8, owner: 'solvenn'  },
  { q: -1, r: 8, owner: 'solvenn'  },
  { q: 0,  r: 8, owner: 'aurelia'  },
  { q: 1,  r: 8, owner: 'aurelia'  },
  { q: 2,  r: 8, owner: 'volkaria' },
  { q: 3,  r: 8, owner: 'volkaria' },
  { q: 4,  r: 8, owner: 'volkaria' },
  { q: 5,  r: 8, owner: 'volkaria' },
  { q: 6,  r: 8, owner: 'volkaria' },
  { q: 7,  r: 8, sea: true },
  { q: 8,  r: 8, sea: true },

  // r=9
  { q: -4, r: 9, sea: true },
  { q: -3, r: 9, sea: true },
  { q: -2, r: 9, sea: true },
  { q: -1, r: 9, owner: 'solvenn'  },
  { q: 0,  r: 9, owner: 'aurelia'  },
  { q: 1,  r: 9, owner: 'aurelia'  },
  { q: 2,  r: 9, owner: 'volkaria' },
  { q: 3,  r: 9, owner: 'volkaria' },
  { q: 4,  r: 9, owner: 'ostara'   },
  { q: 5,  r: 9, owner: 'volkaria' },
  { q: 6,  r: 9, owner: 'volkaria' },
  { q: 7,  r: 9, sea: true },

  // r=10 — southern edge
  { q: -4, r: 10, sea: true },
  { q: -3, r: 10, sea: true },
  { q: -2, r: 10, sea: true },
  { q: -1, r: 10, sea: true },
  { q: 0,  r: 10, sea: true },
  { q: 1,  r: 10, sea: true },
  { q: 2,  r: 10, sea: true },
  { q: 3,  r: 10, owner: 'ostara'  },
  { q: 4,  r: 10, owner: 'ostara'  },
  { q: 5,  r: 10, owner: 'volkaria' },
  { q: 6,  r: 10, sea: true },
]

export function buildInitialState(): GameState {
  const defs: Record<FactionId, FactionDef> = {}
  for (const f of FACTIONS) defs[f.id] = f

  const tiles: Record<string, Tile> = {}
  for (const def of TILES) {
    const hex = { q: def.q, r: def.r }
    tiles[key(hex)] = {
      hex,
      terrain: def.sea ? 'sea' : def.island ? 'island' : 'plains',
      owner: def.owner ?? null,
      contested: !!def.disputed,
      disputedBy: def.disputed,
      dmz: def.dmz ?? false,
      strait: def.strait ?? false,
    }
  }

  // Derive each faction's capital: the most central tile it owns.
  const ownedBy: Record<FactionId, Hex[]> = {}
  for (const t of Object.values(tiles)) {
    if (t.owner) (ownedBy[t.owner] ??= []).push(t.hex)
  }
  const factions: Record<FactionId, Faction> = {}
  for (const f of FACTIONS) {
    const isMajor = f.type === 'player' || f.type === 'rival'
    const owned = ownedBy[f.id] ?? []
    const capital = owned.reduce(
      (best, h) => {
        const score = owned.reduce((s, o) => s + distance(h, o), 0)
        return score < best.score ? { hex: h, score } : best
      },
      { hex: owned[0] ?? { q: 0, r: 0 }, score: Infinity },
    ).hex
    // Trade weight = economic size: big powers (3 cities) are worth far more as a
    // trade partner than small nations (1 city). Market starts at 100 (all trade open,
    // cities intact) and tracks city integrity + open trade thereafter.
    const cityCount = isMajor ? 3 : 1
    factions[f.id] = {
      ...f,
      capital,
      market: 100,
      tradeWeight: isMajor ? 6 : cityCount + 1,
      procurement: { policy: 'civilian', burden: 'standard', aidBoost: 0, aidBoostTurns: 0 },
    }
  }

  // --- Place installations and starting forces ---
  const installations: Installation[] = []
  const forces: Force[] = []
  let iid = 0
  let fid = 0
  const seaAdjacentTo = (h: Hex) => neighbors(h).some((n) => tiles[key(n)]?.terrain === 'sea')

  for (const f of FACTIONS) {
    const cap = factions[f.id].capital
    // Owned plains tiles, capital first, then nearest-out.
    const owned = (ownedBy[f.id] ?? [])
      .filter((h) => tiles[key(h)]?.terrain === 'plains')
      .sort((a, b) => distance(a, cap) - distance(b, cap))
    const seaForward = [...new Set(
      owned.flatMap((h) => neighbors(h).filter((n) => tiles[key(n)]?.terrain === 'sea').map(key)),
    )].map((k) => tiles[k].hex)

    const isMajor = f.type === 'player' || f.type === 'rival'
    const isNeutral = f.type === 'neutral'

    // Cities: capital first, then spread out via farthest-point dispersion so a
    // nation's cities aren't clustered. Great powers get 3, everyone else 1.
    const cityCount = isMajor ? 3 : 1
    const cityHexes: Hex[] = owned.length ? [owned[0]] : []
    const usedForCity = new Set(cityHexes.map(key))
    while (cityHexes.length < cityCount && usedForCity.size < owned.length) {
      let best: Hex | undefined
      let bestD = -1
      for (const h of owned) {
        if (usedForCity.has(key(h))) continue
        const d = Math.min(...cityHexes.map((c) => distance(c, h)))
        if (d > bestD) { bestD = d; best = h }
      }
      if (!best) break
      cityHexes.push(best)
      usedForCity.add(key(best))
    }
    for (const h of cityHexes) {
      installations.push({ id: `i${iid++}`, owner: f.id, type: 'city', hex: h, integrity: BASE_INTEGRITY.city })
    }

    // Bases on remaining owned tiles (not used by a city), nearest the capital first.
    // Kazrek is a militia state: no air base, no navy (it gets extra missiles below).
    const baseTiles = owned.filter((h) => !usedForCity.has(key(h)))
    let s = 0
    const place = (type: InstallationType, hex: Hex | undefined) => {
      if (!hex) return
      const inst: Installation = { id: `i${iid++}`, owner: f.id, type, hex, integrity: BASE_INTEGRITY[type] }
      if (type === 'air_base') { inst.charges = 2; inst.maxCharges = 2 }
      installations.push(inst)
    }
    place('army_base', baseTiles[s++])
    if ((!isNeutral && f.id !== 'kazrek') || f.id === 'ostara') place('air_base', baseTiles[s++])
    if (isMajor) {
      const coastal = baseTiles.slice(s).find((h) => seaAdjacentTo(h)) ?? baseTiles[s]
      place('naval_base', coastal)
      if (coastal) s = Math.max(s, baseTiles.indexOf(coastal) + 1)
      place('army_base', baseTiles[s++]) // (was radar)
    }

    // Forces. Strike platforms (missile/naval) carry 2 charges.
    const mkForce = (type: Force['type'], hex: Hex | undefined) => {
      if (!hex) return
      const strength = type === 'army_group' ? (ARMY_STRENGTH[f.id] ?? FORCE_STRENGTH.army_group) : FORCE_STRENGTH[type]
      const fc: Force = { id: `f${fid++}`, owner: f.id, type, hex, health: FORCE_HEALTH[type], maxHealth: FORCE_HEALTH[type], strength, acted: false }
      if (type === 'missile_battery' || type === 'naval_group') { fc.charges = 2; fc.maxCharges = 2 }
      forces.push(fc)
    }
    const isSmallAlly = f.id === 'mirelle' || f.id === 'solvenn'
    mkForce('army_group', isSmallAlly ? baseTiles[0] : owned[0])
    if (!isNeutral && !isSmallAlly) mkForce('army_group', owned[1] ?? owned[0])
    const missileCount = f.id === 'kazrek' ? 2 : f.id === 'mirelle' ? 0 : (isMajor || f.type === 'ally' || f.id === 'khorul') ? 1 : 0
    for (let m = 0; m < missileCount; m++) mkForce('missile_battery', owned[Math.min(2 + m, owned.length - 1)])
    if (isMajor) mkForce('naval_group', seaForward[0])
  }

  // Forward-base the great powers at the chokepoints: army bases on the land bridge
  // facing each other, naval bases on the strait shore.
  const relocate = (factionId: FactionId, enemyId: FactionId) => {
    const cityKeys = new Set(installations.filter((i) => i.owner === factionId && i.type === 'city').map((i) => key(i.hex)))
    // Don't stack a base on a city tile.
    const ownedPlains = Object.values(tiles)
      .filter((t) => t.owner === factionId && t.terrain === 'plains' && !cityKeys.has(key(t.hex)))
      .map((t) => t.hex)
    const bridge = ownedPlains.find((h) => neighbors(h).some((n) => tiles[key(n)]?.owner === enemyId))
    if (bridge) { const ab = installations.find((i) => i.owner === factionId && i.type === 'army_base'); if (ab) ab.hex = bridge }
    const enemyCap = factions[enemyId].capital
    const shore = ownedPlains
      .filter((h) => neighbors(h).some((n) => tiles[key(n)]?.terrain === 'sea') && (!bridge || key(h) !== key(bridge)))
      .sort((a, b) => distance(a, enemyCap) - distance(b, enemyCap))[0]
    if (shore) { const nb = installations.find((i) => i.owner === factionId && i.type === 'naval_base'); if (nb) nb.hex = shore }
  }
  relocate('aurelia', 'volkaria')
  relocate('volkaria', 'aurelia')

  // Berth each great power's fleet at its own naval base (docked).
  const dockNavy = (factionId: FactionId) => {
    const navy = forces.find((f) => f.owner === factionId && f.type === 'naval_group')
    const base = installations.find((i) => i.owner === factionId && i.type === 'naval_base')
    if (navy && base) navy.hex = base.hex
  }
  dockNavy('aurelia')
  dockNavy('volkaria')

  // Amphibious marines: only the two great powers field them. One weaker, sea-mobile
  // marine group each, berthed at the naval base, ready to storm a coast from the strait.
  for (const factionId of ['aurelia', 'volkaria'] as FactionId[]) {
    const base = installations.find((i) => i.owner === factionId && i.type === 'naval_base')
    if (base) forces.push({
      id: `f${fid++}`, owner: factionId, type: 'marine', hex: base.hex,
      health: FORCE_HEALTH.marine, maxHealth: FORCE_HEALTH.marine,
      strength: FORCE_STRENGTH.marine, acted: false,
    })
  }

  // Extra forces staged at each great power's southern (forward) army base.
  const southernBase = (factionId: FactionId) =>
    installations
      .filter((i) => i.owner === factionId && i.type === 'army_base')
      .sort((a, b) => b.hex.r - a.hex.r)[0]

  const sbAur = southernBase('aurelia')
  if (sbAur) forces.push({
    id: `f${fid++}`, owner: 'aurelia', type: 'army_group', hex: sbAur.hex,
    health: FORCE_HEALTH.army_group, maxHealth: FORCE_HEALTH.army_group,
    strength: ARMY_STRENGTH.aurelia ?? FORCE_STRENGTH.army_group, acted: false,
  })

  const sbVol = southernBase('volkaria')
  if (sbVol) forces.push({
    id: `f${fid++}`, owner: 'volkaria', type: 'missile_battery', hex: sbVol.hex,
    health: FORCE_HEALTH.missile_battery, maxHealth: FORCE_HEALTH.missile_battery,
    strength: FORCE_STRENGTH.missile_battery, acted: false, charges: 2, maxCharges: 2,
  })

  // Esquana: disputed territory warrants a naval base, fleet, and missile battery.
  const esqUsed = new Set(installations.filter((i) => i.owner === 'esquana').map((i) => key(i.hex)))
  const esqCoastal = Object.values(tiles)
    .filter((t) => t.owner === 'esquana' && t.terrain === 'plains' && !esqUsed.has(key(t.hex)))
    .filter((t) => neighbors(t.hex).some((n) => tiles[key(n)]?.terrain === 'sea'))
    .sort((a, b) => distance(a.hex, factions['esquana'].capital) - distance(b.hex, factions['esquana'].capital))[0]
  if (esqCoastal) {
    installations.push({ id: `i${iid++}`, owner: 'esquana', type: 'naval_base', hex: esqCoastal.hex, integrity: BASE_INTEGRITY.naval_base })
    forces.push({ id: `f${fid++}`, owner: 'esquana', type: 'naval_group', hex: esqCoastal.hex, health: FORCE_HEALTH.naval_group, maxHealth: FORCE_HEALTH.naval_group, strength: FORCE_STRENGTH.naval_group, acted: false, charges: 2, maxCharges: 2 })
  }
  const esqArmyBase = installations.find((i) => i.owner === 'esquana' && i.type === 'army_base')
  if (esqArmyBase) {
    forces.push({ id: `f${fid++}`, owner: 'esquana', type: 'missile_battery', hex: esqArmyBase.hex, health: FORCE_HEALTH.missile_battery, maxHealth: FORCE_HEALTH.missile_battery, strength: FORCE_STRENGTH.missile_battery, acted: false, charges: 2, maxCharges: 2 })
  }

  // Stage the flashpoint: poise a Kazrek army group on the tile it owns next to the
  // DMZ, ready to march in and claim the holy ground.
  const dmzHex = Object.values(tiles).find((t) => t.dmz)?.hex
  if (dmzHex) {
    const staging = neighbors(dmzHex).find((h) => tiles[key(h)]?.owner === 'kazrek' && tiles[key(h)]?.terrain === 'plains')
    if (staging) {
      const kazArmy = forces.find((f) => f.owner === 'kazrek' && f.type === 'army_group')
      if (kazArmy) kazArmy.hex = staging
      else forces.push({
        id: `f${fid++}`, owner: 'kazrek', type: 'army_group', hex: staging,
        health: FORCE_HEALTH.army_group, maxHealth: FORCE_HEALTH.army_group,
        strength: ARMY_STRENGTH.kazrek ?? FORCE_STRENGTH.army_group,
        acted: false,
      })
    }
  }

  return {
    turn: 1,
    order: FACTIONS.map((f) => f.id),
    turnIndex: 0,
    factions,
    tiles,
    installations,
    forces,
    deathToll: 0,
    factionDeaths: Object.fromEntries(FACTIONS.map((f) => [f.id, 0])),
    embargoes: [],
    embargoedBy: {},
    ceasefires: [],
    ceasefireRequests: [],
    diplomaticMessages: [],
    log: [
      { turn: 1, kind: 'system', text: 'Crisis begins. Radical Kazrek presses its religious claim to the demilitarized zone on Aurelias shores and masses an army group to march in and seize it.' },
      { turn: 1, kind: 'system', text: 'Backing Kazrek down is hard; doing nothing signals weakness. Aurelia moves first — step each nation through its turn with “End Turn”.' },
    ],
    supportCrises: [],
  }
}
