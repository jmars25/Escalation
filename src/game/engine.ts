// Pure-ish game logic. Each function takes the current state and returns a new
// one (we deep-clone, then mutate the clone). State is plain data, so
// structuredClone is safe and keeps call sites simple.
//
// There is no AI: the game is hotseat. `endFactionTurn` simply advances to the
// next nation in `order`. In Phase 3 that seam is where a Claude agent takes a
// faction's turn instead of the human.

import type {
  AidPackageType, Alignment, CeasefireRequest, CeasefireResponse, Force, ForceType, GameState, Hex, Installation, InstallationType,
  PeaceTerm,
  ProcurementBurden, ProcurementPolicy, ProcurementProjectType,
} from './types'
import { distance, hexEquals, key, neighbors } from './hexUtils'

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n))

function clone(s: GameState): GameState {
  return structuredClone(s)
}

export function currentFactionId(s: GameState): string {
  return s.order[s.turnIndex]
}

export function forcesAt(s: GameState, h: Hex): Force[] {
  return s.forces.filter((f) => hexEquals(f.hex, h))
}

/** Terrain rules: naval = sea (or docked at a friendly naval base); army = land;
 *  missiles deploy anywhere (not impassable mountains). Stacking is unlimited. */
export function canEnter(s: GameState, force: Force, h: Hex): boolean {
  const t = s.tiles[key(h)]
  if (!t) return false
  if (force.type === 'naval_group') {
    if ((t.terrain === 'sea' || t.terrain === 'island') && t.strait) return true
    return s.installations.some((i) => i.type === 'naval_base' && i.owner === force.owner && hexEquals(i.hex, h))
  }
  // Marines move over land like an army, but may also put to sea on the strait.
  if (force.type === 'marine') {
    if ((t.terrain === 'sea' || t.terrain === 'island') && t.strait) return true
    return t.terrain === 'plains'
  }
  if (force.type === 'missile_battery') return t.terrain !== 'mountain'
  return t.terrain === 'plains' // army_group
}

function alignmentOf(s: GameState, id: string | null): Alignment | null {
  return id ? s.factions[id].alignment : null
}

/** Is moving here a provocative forward deployment? True near the opposing side. */
function isForward(s: GameState, mover: string, h: Hex): boolean {
  const mine = alignmentOf(s, mover)
  if (mine === 'neutral') return false
  const opposite: Alignment = mine === 'coalition' ? 'bloc' : 'coalition'
  const here = s.tiles[key(h)]
  if (here?.contested) return true
  if (alignmentOf(s, here?.owner ?? null) === opposite) return true
  return neighbors(h).some((n) => {
    const t = s.tiles[key(n)]
    return alignmentOf(s, t?.owner ?? null) === opposite || !!t?.contested
  })
}

function log(s: GameState, e: Omit<GameState['log'][number], 'turn'>) {
  s.log = [{ ...e, turn: s.turn }, ...s.log].slice(0, 200)
}

function ensureDiplomacy(s: GameState) {
  s.ceasefires ??= []
  s.ceasefireRequests ??= []
  s.peacePairAttemptTurn ??= {}
  s.diplomaticMessages ??= []
}

function nextDiplomacyId(s: GameState, prefix: string): string {
  ensureDiplomacy(s)
  const ids = [
    ...s.ceasefireRequests.map((item) => item.id),
    ...s.diplomaticMessages.map((item) => item.id),
  ]
  let best = -1
  for (const id of ids) {
    if (!id.startsWith(prefix)) continue
    const n = Number(id.slice(prefix.length))
    if (Number.isFinite(n)) best = Math.max(best, n)
  }
  return `${prefix}${best + 1}`
}

function cleanDiplomaticMessage(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ')
  const sentences = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [trimmed]
  return sentences.slice(0, 3).join(' ').slice(0, 420).trim()
}

function ensureDeathLedger(s: GameState) {
  s.deathToll ??= 0
  s.factionDeaths ??= {}
  for (const id of Object.keys(s.factions)) s.factionDeaths[id] ??= 0
}

function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

function addDeaths(s: GameState, factionId: string, amount: number): number {
  const deaths = Math.max(0, Math.round(amount))
  if (!deaths) return 0
  ensureDeathLedger(s)
  s.deathToll += deaths
  s.factionDeaths[factionId] = (s.factionDeaths[factionId] ?? 0) + deaths
  return deaths
}

function formatDeaths(n: number): string {
  return n.toLocaleString('en-US')
}

function deathNote(n: number): string {
  return n > 0 ? ` Estimated deaths: ${formatDeaths(n)}.` : ''
}

function forceDeaths(type: ForceType, hpDamage: number, destroyed: boolean): number {
  const perHp: Record<ForceType, [number, number]> = {
    army_group: [6, 16],
    marine: [5, 14],
    naval_group: [4, 12],
    missile_battery: [1, 4],
  }
  const [lo, hi] = perHp[type]
  const base = hpDamage * randInt(lo, hi)
  return destroyed ? base + randInt(lo * 2, hi * 5) : base
}

function installationDeaths(type: InstallationType, damage: number, intensity: StrikeIntensity, destroyed: boolean): number {
  if (damage <= 0) return 0
  const full = intensity === 'full'
  const perPoint: Record<InstallationType, [number, number]> = {
    city: full ? [5, 12] : [1, 5],
    army_base: full ? [1, 3] : [0, 1],
    air_base: full ? [1, 3] : [0, 1],
    naval_base: full ? [1, 4] : [0, 1],
    radar: full ? [0, 1] : [0, 1],
  }
  const [lo, hi] = perPoint[type]
  const base = damage * randInt(lo, hi)
  if (type === 'city') return base
  return destroyed ? base + randInt(8, 45) : base
}

function isAdjacent(a: Hex, b: Hex): boolean {
  return neighbors(a).some((n) => hexEquals(n, b))
}

function ceasefireBlocksEntry(s: GameState, force: Force, h: Hex): boolean {
  const t = s.tiles[key(h)]
  if (t?.owner && t.owner !== force.owner && hasCeasefire(s, force.owner, t.owner)) return true
  return [...s.forces, ...s.installations].some((item) =>
    item.owner !== force.owner && hexEquals(item.hex, h) && hasCeasefire(s, force.owner, item.owner),
  )
}

function isDeployTarget(s: GameState, force: Force, h: Hex): boolean {
  if (force.acted || hexEquals(force.hex, h) || !canEnter(s, force, h)) return false
  const t = s.tiles[key(h)]
  if (!t) return false
  if (ceasefireBlocksEntry(s, force, h)) return false
  if (tileDefenders(s, h, s.factions[force.owner].alignment, force.owner).length > 0) return false
  if (force.type === 'naval_group') {
    if ((t.terrain === 'sea' || t.terrain === 'island') && t.strait) return true
    return t.owner === force.owner // docking at own naval base on land
  }
  // Marines deploy across home soil like an army, or stage out onto the strait.
  if (force.type === 'marine') {
    if ((t.terrain === 'sea' || t.terrain === 'island') && t.strait) return true
    return t.owner === force.owner && t.terrain === 'plains'
  }
  return t.owner === force.owner
}

function isArmyAttackTarget(s: GameState, force: Force, h: Hex): boolean {
  const groundUnit = force.type === 'army_group' || force.type === 'marine'
  if (force.acted || !groundUnit || !isAdjacent(force.hex, h) || !canEnter(s, force, h)) return false
  const t = s.tiles[key(h)]
  if (!t || t.terrain !== 'plains') return false // ground assault only seizes land (marines storm a coast)
  if (ceasefireBlocksEntry(s, force, h)) return false
  const mine = s.factions[force.owner].alignment
  return t.owner !== force.owner || !!t.disputedBy || !!t.dmz || tileDefenders(s, h, mine, force.owner).length > 0
}

function isNavalAssaultTarget(s: GameState, force: Force, h: Hex): boolean {
  if (force.acted || force.type !== 'naval_group' || !isAdjacent(force.hex, h) || !canEnter(s, force, h)) return false
  const t = s.tiles[key(h)]
  if (!t || t.terrain !== 'island') return false
  if (ceasefireBlocksEntry(s, force, h)) return false
  return tileDefenders(s, h, s.factions[force.owner].alignment, force.owner).length > 0
}

/** Legal actions for a force: deploy anywhere reachable, or for armies/navies,
 *  assault adjacent contested ground. Both consume the force's turn. */
export function legalMoves(s: GameState, force: Force): Hex[] {
  if (force.acted || s.factions[force.owner]?.exiled) return []
  const out = new Map<string, Hex>()
  for (const t of Object.values(s.tiles)) {
    if (isDeployTarget(s, force, t.hex)) out.set(key(t.hex), t.hex)
  }
  for (const h of neighbors(force.hex)) {
    if (isArmyAttackTarget(s, force, h)) out.set(key(h), h)
    if (isNavalAssaultTarget(s, force, h)) out.set(key(h), h)
  }
  return [...out.values()]
}

// --- Actions --------------------------------------------------------------

/** Damaged units fight weaker — effective strength scales down to 50% at low HP. */
function healthFactor(f: Force): number {
  return 0.5 + 0.5 * (f.health / f.maxHealth)
}

type Defender =
  | { kind: 'force'; force: Force; defStrength: number }
  | { kind: 'inst'; inst: Installation; defStrength: number }

/** Everything hostile on a tile that opposes a ground assault. Enemy armies/naval use
 *  their strength; missile batteries defend weakly (~1.5); bases defend in proportion to
 *  their integrity (a full base is sort of strong; a battered one is weak). */
function tileDefenders(s: GameState, to: Hex, attackerAlign: Alignment, attackerId?: string): Defender[] {
  const enemy = (id: string) => s.factions[id].alignment !== attackerAlign && (!attackerId || !hasCeasefire(s, attackerId, id))
  const out: Defender[] = []
  for (const f of s.forces) {
    if (!hexEquals(f.hex, to) || !enemy(f.owner)) continue
    if (f.type === 'army_group' || f.type === 'marine' || f.type === 'naval_group') out.push({ kind: 'force', force: f, defStrength: f.strength })
    else if (f.type === 'missile_battery') out.push({ kind: 'force', force: f, defStrength: 1.5 })
  }
  for (const i of s.installations) {
    if (!hexEquals(i.hex, to) || !enemy(i.owner) || i.integrity <= 0) continue
    out.push({ kind: 'inst', inst: i, defStrength: i.integrity / 20 })
  }
  return out
}

function claimOccupiedHex(s: GameState, force: Force): boolean {
  const t = s.tiles[key(force.hex)]
  if (!t || t.owner === force.owner) return false
  if (t.owner && hasCeasefire(s, force.owner, t.owner)) return false
  const isLandClaim = (force.type === 'army_group' || force.type === 'marine') && t.terrain === 'plains'
  const isIslandClaim = force.type === 'naval_group' && t.terrain === 'island'
  if (!isLandClaim && !isIslandClaim) return false
  const prevOwner = t.owner
  const wasDmz = t.dmz
  const wasDisputed = !!t.disputedBy?.length || t.contested
  const disputedNames = t.disputedBy?.map((id) => s.factions[id]?.name ?? id).join(' and ')
  t.lastOwner = prevOwner
  t.owner = force.owner
  t.dmz = false
  t.disputedBy = undefined
  t.contested = true
  transferCitiesOnHex(s, force.hex, force.owner, prevOwner)
  if (prevOwner) s.factions[prevOwner].disposition = clamp(s.factions[prevOwner].disposition - 10, -100, 100)
  force.acted = true
  if (!wasDmz && wasDisputed) {
    log(s, {
      kind: 'system', faction: force.owner,
      text: `${s.factions[force.owner].name} seizes disputed territory${disputedNames ? ` claimed by ${disputedNames}` : ''} from ${prevOwner ? s.factions[prevOwner].name : 'no one'} - a major diplomatic crisis requiring a response.`,
    })
    checkRegime(s)
    return true
  }
  log(s, {
    kind: 'system', faction: force.owner,
    text: wasDmz
      ? `${s.factions[force.owner].name} claims the demilitarized zone by force - a blatant provocation.`
      : wasDisputed
        ? `${s.factions[force.owner].name} claims disputed territory${disputedNames ? ` claimed by ${disputedNames}` : ''} - a major diplomatic crisis requiring a response.`
        : `${s.factions[force.owner].name} claims ${prevOwner ? s.factions[prevOwner].name : 'disputed'} ground.`,
  })
  return true
}

/** Ground assault on a hostile tile, Civ-style. Resolves against the toughest defender
 *  present (army > base > battery); both sides take damage. The army seizes the tile only
 *  once every defender is cleared — armies destroyed, bases pounded down, batteries broken. */
export function resolveAssault(state: GameState, attackerId: string, to: Hex): GameState {
  const s = clone(state)
  const atk = s.forces.find((f) => f.id === attackerId)
  if (!atk || (atk.type !== 'army_group' && atk.type !== 'marine') || atk.acted || s.factions[atk.owner]?.exiled) return state
  if (!isArmyAttackTarget(s, atk, to)) return state
  const mine = s.factions[atk.owner].alignment
  const defs = tileDefenders(s, to, mine, atk.owner)
  if (!defs.length) return state
  atk.acted = true
  const d = defs.sort((a, b) => b.defStrength - a.defStrength)[0]

  const effA = atk.strength * healthFactor(atk)
  const effD = d.kind === 'force' ? d.defStrength * healthFactor(d.force) : d.defStrength
  const r = () => 0.75 + Math.random() * 0.5
  const dmgToAtk = clamp(Math.round(16 * (effD / effA) * r()), 1, 100)
  const dmgRoll = clamp(Math.round(16 * (effA / effD) * r()), 1, 100)
  const atkHpBefore = atk.health
  const actualAtkDamage = Math.min(dmgToAtk, atkHpBefore)
  atk.health -= dmgToAtk

  let defName: string
  let ownerId: string
  let unit: string
  let dmgToDef: number
  let defenderDeaths = 0
  if (d.kind === 'force') {
    dmgToDef = Math.min(dmgRoll, d.force.health)
    d.force.health -= dmgToDef
    defName = forceNoun(d.force.type); ownerId = d.force.owner; unit = ' HP'
    const defDestroyed = d.force.health <= 0
    defenderDeaths = addDeaths(s, d.force.owner, forceDeaths(d.force.type, dmgToDef, defDestroyed))
    if (defDestroyed) s.forces = s.forces.filter((f) => f.id !== d.force.id)
  } else {
    dmgToDef = Math.min(dmgRoll, d.inst.integrity)
    d.inst.integrity = Math.max(0, d.inst.integrity - dmgToDef)
    defName = d.inst.type.replace('_', ' '); ownerId = d.inst.owner; unit = '% integrity'
    if (d.inst.type === 'city') recomputeMarket(s, d.inst.owner)
    const instDestroyed = d.inst.type !== 'city' && d.inst.integrity <= 0
    defenderDeaths = addDeaths(s, d.inst.owner, installationDeaths(d.inst.type, dmgToDef, 'limited', instDestroyed))
    if (instDestroyed) s.installations = s.installations.filter((i) => i.id !== d.inst.id)
  }

  const atkDead = atk.health <= 0
  const attackerDeaths = addDeaths(s, atk.owner, forceDeaths(atk.type, actualAtkDamage, atkDead))
  if (atkDead) s.forces = s.forces.filter((f) => f.id !== atk.id)
  const cleared = !atkDead && tileDefenders(s, to, mine, atk.owner).length === 0
  let outcome: string
  if (cleared) {
    atk.hex = to
    const claimed = claimOccupiedHex(s, atk)
    outcome = claimed ? 'and claims the position' : 'and seizes the position'
  }
  else if (atkDead) outcome = 'and is wiped out'
  else outcome = 'but the position holds'

  s.factions[ownerId].disposition = clamp(s.factions[ownerId].disposition - 6, -100, 100)
  log(s, { kind: 'system', faction: atk.owner, text: `${s.factions[atk.owner].name}'s army assaults ${s.factions[ownerId].name}'s ${defName} (−${dmgToDef}${unit}), taking −${dmgToAtk} HP ${outcome}.${deathNote(attackerDeaths + defenderDeaths)}` })
  checkRegime(s)
  return s
}

/** Naval assault on a defended island — same Civ-style HP combat as a ground assault,
 *  but only naval groups fight over island terrain. Island is claimed once defenders clear. */
export function resolveNavalAssault(state: GameState, attackerId: string, to: Hex): GameState {
  const s = clone(state)
  const atk = s.forces.find((f) => f.id === attackerId)
  if (!atk || atk.type !== 'naval_group' || atk.acted || s.factions[atk.owner]?.exiled) return state
  if (!isNavalAssaultTarget(s, atk, to)) return state
  const mine = s.factions[atk.owner].alignment
  const defs = tileDefenders(s, to, mine, atk.owner)
  if (!defs.length) return state
  atk.acted = true
  const d = defs.sort((a, b) => b.defStrength - a.defStrength)[0]

  const effA = atk.strength * healthFactor(atk)
  const effD = d.kind === 'force' ? d.defStrength * healthFactor(d.force) : d.defStrength
  const r = () => 0.75 + Math.random() * 0.5
  const dmgToAtk = clamp(Math.round(16 * (effD / effA) * r()), 1, 100)
  const dmgRoll = clamp(Math.round(16 * (effA / effD) * r()), 1, 100)
  const atkHpBefore = atk.health
  const actualAtkDamage = Math.min(dmgToAtk, atkHpBefore)
  atk.health -= dmgToAtk

  let defName: string
  let ownerId: string
  let unit: string
  let dmgToDef: number
  let defenderDeaths = 0
  if (d.kind === 'force') {
    dmgToDef = Math.min(dmgRoll, d.force.health)
    d.force.health -= dmgToDef
    defName = forceNoun(d.force.type); ownerId = d.force.owner; unit = ' HP'
    const defDestroyed = d.force.health <= 0
    defenderDeaths = addDeaths(s, d.force.owner, forceDeaths(d.force.type, dmgToDef, defDestroyed))
    if (defDestroyed) s.forces = s.forces.filter((f) => f.id !== d.force.id)
  } else {
    dmgToDef = Math.min(dmgRoll, d.inst.integrity)
    d.inst.integrity = Math.max(0, d.inst.integrity - dmgToDef)
    defName = d.inst.type.replace('_', ' '); ownerId = d.inst.owner; unit = '% integrity'
    const instDestroyed = d.inst.type !== 'city' && d.inst.integrity <= 0
    defenderDeaths = addDeaths(s, d.inst.owner, installationDeaths(d.inst.type, dmgToDef, 'limited', instDestroyed))
    if (instDestroyed) s.installations = s.installations.filter((i) => i.id !== d.inst.id)
  }

  const atkDead = atk.health <= 0
  const attackerDeaths = addDeaths(s, atk.owner, forceDeaths(atk.type, actualAtkDamage, atkDead))
  if (atkDead) s.forces = s.forces.filter((f) => f.id !== atk.id)
  const cleared = !atkDead && tileDefenders(s, to, mine, atk.owner).length === 0
  let outcome: string
  if (cleared) {
    atk.hex = to
    const claimed = claimOccupiedHex(s, atk)
    outcome = claimed ? 'and claims the island' : 'and secures the island'
  } else if (atkDead) {
    outcome = 'and is sunk'
  } else {
    outcome = 'but the island holds'
  }

  s.factions[ownerId].disposition = clamp(s.factions[ownerId].disposition - 6, -100, 100)
  log(s, { kind: 'system', faction: atk.owner, text: `${s.factions[atk.owner].name}'s fleet engages ${s.factions[ownerId].name}'s ${defName} (−${dmgToDef}${unit}), taking −${dmgToAtk} HP ${outcome}.${deathNote(attackerDeaths + defenderDeaths)}` })
  checkRegime(s)
  return s
}

export function moveForce(state: GameState, forceId: string, to: Hex): GameState {
  const s = clone(state)
  const force = s.forces.find((f) => f.id === forceId)
  if (!force || s.factions[force.owner]?.exiled) return state
  if (ceasefireBlocksEntry(s, force, to)) return state
  const deploying = isDeployTarget(s, force, to)
  const attacking = isArmyAttackTarget(s, force, to)
  const navalAssaulting = isNavalAssaultTarget(s, force, to)
  if (!deploying && !attacking && !navalAssaulting) return state

  if (navalAssaulting) return resolveNavalAssault(state, forceId, to)

  if (attacking && (force.type === 'army_group' || force.type === 'marine')) {
    const mine = s.factions[force.owner].alignment
    // Any defenders on the tile (enemy army, battery, or base) must be fought down
    // before you can advance — see resolveAssault.
    if (tileDefenders(s, to, mine, force.owner).length) return resolveAssault(state, forceId, to)
    // Otherwise, hostile territory still has weak local defense (~strength 1) that
    // bloodies an advancing army — taking ground always costs something.
    const t = s.tiles[key(to)]
    force.acted = true
    if (t?.owner && t.owner !== force.owner) {
      const toll = clamp(Math.round((20 / force.strength) * (0.8 + Math.random() * 0.5)), 1, 100)
      const land = s.factions[t.owner].name
      const forceHpBefore = force.health
      const actualForceDamage = Math.min(toll, forceHpBefore)
      force.health -= toll
      const attackerDeaths = addDeaths(s, force.owner, forceDeaths(force.type, actualForceDamage, force.health <= 0))
      const localDeaths = addDeaths(s, t.owner, randInt(5, 35))
      s.factions[t.owner].disposition = clamp(s.factions[t.owner].disposition - 4, -100, 100)
      if (force.health <= 0) {
        s.forces = s.forces.filter((f) => f.id !== force.id)
        log(s, { kind: 'system', faction: force.owner, text: `${s.factions[force.owner].name}'s army is destroyed assaulting ${land} territory.${deathNote(attackerDeaths + localDeaths)}` })
      } else {
        force.hex = to
        claimOccupiedHex(s, force)
        log(s, { kind: 'system', faction: force.owner, text: `${s.factions[force.owner].name}'s army pushes into ${land} territory against local resistance (−${toll} HP).${deathNote(attackerDeaths + localDeaths)}` })
      }
      return s
    }
    force.hex = to
    claimOccupiedHex(s, force)
    return s
  }

  force.hex = to
  force.acted = true
  claimOccupiedHex(s, force) // naval landing on an island auto-claims it
  if (isForward(s, force.owner, to)) {
    const label = LABEL[force.type]
    log(s, { kind: 'system', faction: force.owner, text: `${s.factions[force.owner].name} forward-deploys ${label} toward the frontier.` })
  }
  return s
}

export const LABEL: Record<Force['type'], string> = {
  army_group: 'an army group',
  marine: 'a marine group',
  naval_group: 'a naval group',
  missile_battery: 'a missile battery',
}

const forceNoun = (t: Force['type']) => LABEL[t].replace(/^an? /, '')

// --- Claim territory (a political maneuver, not conquest) ------------------

/** Only army groups occupy/claim, on a plains tile that isn't yours — and only once
 *  any opposing army group defending the tile has been destroyed. */
export function canClaim(s: GameState, force: Force): boolean {
  if (force.acted || s.factions[force.owner]?.exiled) return false
  const t = s.tiles[key(force.hex)]
  if (!t || t.owner === force.owner) return false
  if (t.owner && hasCeasefire(s, force.owner, t.owner)) return false
  if ((force.type === 'army_group' || force.type === 'marine') && t.terrain !== 'plains') return false
  if (force.type === 'naval_group' && t.terrain !== 'island') return false
  if (force.type === 'missile_battery') return false
  const mine = s.factions[force.owner].alignment
  const blockerType = force.type === 'naval_group' ? 'naval_group' : 'army_group'
  const defended = s.forces.some(
    (f) => f.id !== force.id && f.type === blockerType && hexEquals(f.hex, force.hex) && s.factions[f.owner].alignment !== mine && !hasCeasefire(s, force.owner, f.owner),
  )
  return !defended
}

export function claimHex(state: GameState, forceId: string): GameState {
  const s = clone(state)
  const force = s.forces.find((f) => f.id === forceId)
  if (!force || !canClaim(s, force)) return state
  const t = s.tiles[key(force.hex)]
  const prevOwner = t.owner
  const wasDmz = t.dmz
  const wasDisputed = !!t.disputedBy?.length || t.contested
  const disputedNames = t.disputedBy?.map((id) => s.factions[id]?.name ?? id).join(' and ')
  t.lastOwner = prevOwner
  t.owner = force.owner
  t.dmz = false
  t.disputedBy = undefined
  t.contested = true
  transferCitiesOnHex(s, force.hex, force.owner, prevOwner)
  if (prevOwner) s.factions[prevOwner].disposition = clamp(s.factions[prevOwner].disposition - 10, -100, 100)
  force.acted = true
  if (!wasDmz && wasDisputed) {
    log(s, {
      kind: 'system', faction: force.owner,
      text: `${s.factions[force.owner].name} seizes disputed territory${disputedNames ? ` claimed by ${disputedNames}` : ''} from ${prevOwner ? s.factions[prevOwner].name : 'no one'} - a major diplomatic crisis requiring a response.`,
    })
    checkRegime(s)
    return s
  }
  log(s, {
    kind: 'system', faction: force.owner,
    text: wasDmz
      ? `${s.factions[force.owner].name} marches into the demilitarized zone and claims it — a blatant provocation.`
      : `${s.factions[force.owner].name} seizes contested ground from ${prevOwner ? s.factions[prevOwner].name : 'no one'}.`,
  })
  checkRegime(s)
  return s
}

// --- Strikes (political instruments) --------------------------------------

export type StrikeKind = 'air' | 'naval' | 'missile'
export type StrikeIntensity = 'limited' | 'full'

const STRIKE_RANGE = { naval: 3, missile: 4, air: 5 } as const
// Damage vs structures (installations) — bases take a pounding over several hits.
const STRUCT: Record<StrikeKind, Record<StrikeIntensity, [number, number]>> = {
  air: { limited: [18, 34], full: [38, 64] },
  naval: { limited: [14, 26], full: [30, 50] },
  missile: { limited: [7, 15], full: [16, 28] },
}
// Damage vs forces — a Civ-style combat roll: hurts, but rarely a one-shot kill.
const COMBAT: Record<StrikeKind, Record<StrikeIntensity, [number, number]>> = {
  air: { limited: [8, 15], full: [16, 26] },
  naval: { limited: [6, 12], full: [12, 20] },
  missile: { limited: [4, 8], full: [8, 14] },
}
const rnd = (a: number, b: number) => Math.floor(Math.random() * (b - a + 1)) + a
const rollStruct = (k: StrikeKind, i: StrikeIntensity) => rnd(...STRUCT[k][i])
const rollCombat = (k: StrikeKind, i: StrikeIntensity) => rnd(...COMBAT[k][i])
const chargeCost = (intensity: StrikeIntensity) => (intensity === 'full' ? 2 : 1)
// Installations that garrison/shield forces on their tile until destroyed.
const PROTECTING: Installation['type'][] = ['city', 'army_base', 'naval_base']

const KIND_LABEL: Record<StrikeKind, string> = { air: 'air strike', naval: 'naval strike', missile: 'missile strike' }

export function canStrike(force: Force): boolean {
  return !force.acted && (force.type === 'naval_group' || force.type === 'missile_battery') && (force.charges ?? 0) >= 1
}
function kindOf(force: Force): StrikeKind {
  return force.type === 'naval_group' ? 'naval' : 'missile'
}

function enemiesInRange(s: GameState, factionId: string, from: Hex, range: number): Hex[] {
  const mine = s.factions[factionId].alignment
  const enemy = (id: string | null) => !!id && s.factions[id].alignment !== mine && !hasCeasefire(s, factionId, id)
  const keys = new Set<string>()
  for (const f of s.forces) if (enemy(f.owner) && distance(from, f.hex) <= range) keys.add(key(f.hex))
  for (const i of s.installations) if (enemy(i.owner) && distance(from, i.hex) <= range) keys.add(key(i.hex))
  return [...keys].map((k) => s.tiles[k].hex)
}

export function strikeTargets(s: GameState, force: Force): Hex[] {
  if (!canStrike(force) || s.factions[force.owner]?.exiled) return []
  return enemiesInRange(s, force.owner, force.hex, STRIKE_RANGE[kindOf(force)])
}

/** Hexes a specific air base can reach (empty if it has no sorties). */
export function airBaseTargets(s: GameState, baseId: string): Hex[] {
  const base = s.installations.find((i) => i.id === baseId)
  if (!base || base.type !== 'air_base' || (base.charges ?? 0) < 1 || s.factions[base.owner]?.exiled) return []
  return enemiesInRange(s, base.owner, base.hex, STRIKE_RANGE.air)
}

export function airPower(s: GameState, factionId: string): { bases: number; charges: number } {
  const bases = s.installations.filter((i) => i.type === 'air_base' && i.owner === factionId)
  return { bases: bases.length, charges: bases.reduce((a, b) => a + (b.charges ?? 0), 0) }
}

// --- Procurement ----------------------------------------------------------

export const PROJECT_LABEL: Record<ProcurementProjectType, string> = {
  army_group: 'Army group',
  missile_battery: 'Missile battery',
  naval_group: 'Naval group',
  air_base: 'Air base',
  naval_base: 'Naval base',
}

export const PROJECT_COST: Record<ProcurementProjectType, number> = {
  army_group: 120,
  missile_battery: 100,
  naval_group: 120,
  air_base: 200,
  naval_base: 200,
}

const POLICY_RATE: Record<ProcurementPolicy, number> = {
  civilian: 0,
  contracts: 20,
  emergency: 32,
  draft: 22,
}

const BURDEN_MULT: Record<ProcurementBurden, number> = {
  low: 0.65,
  standard: 1,
  high: 1.55,
  crisis: 2.2,
}

const BURDEN_ECONOMY_COST: Record<ProcurementBurden, number> = {
  low: 1,
  standard: 3,
  high: 6,
  crisis: 10,
}

const BURDEN_SUPPORT_COST: Record<ProcurementBurden, number> = {
  low: 0,
  standard: 1,
  high: 3,
  crisis: 6,
}

const POLICY_SUPPORT_COST: Record<ProcurementPolicy, number> = {
  civilian: 0,
  contracts: 0,
  emergency: 1,
  draft: 4,
}

const NEW_FORCE_HEALTH: Record<ForceType, number> = {
  army_group: 40,
  marine: 30,
  naval_group: 55,
  missile_battery: 28,
}

const NEW_FORCE_STRENGTH: Record<ForceType, number> = {
  army_group: 7,
  marine: 5,
  naval_group: 9,
  missile_battery: 4,
}

const NEW_ARMY_STRENGTH: Record<string, number> = { aurelia: 10, kazrek: 10 }

const NEW_BASE_INTEGRITY: Record<InstallationType, number> = {
  city: 100,
  naval_base: 110,
  army_base: 95,
  air_base: 90,
  radar: 55,
}

export function procurementRate(s: GameState, factionId: string): number {
  const p = s.factions[factionId]?.procurement
  if (!p?.project) return 0
  const type = p.project.type
  const policyWorks = type === 'army_group'
    ? p.policy === 'draft'
    : p.policy === 'contracts' || p.policy === 'emergency'
  if (!policyWorks) return 0
  return Math.round(POLICY_RATE[p.policy] * BURDEN_MULT[p.burden] + p.aidBoost)
}

export function projectCost(type: ProcurementProjectType): number {
  return PROJECT_COST[type]
}

export function setProcurementPolicy(state: GameState, factionId: string, policy: ProcurementPolicy): GameState {
  const s = clone(state)
  const f = s.factions[factionId]
  if (!f || f.exiled || f.procurement.policy === policy) return state
  f.procurement.policy = policy
  if (policy === 'draft') {
    f.support = clamp(f.support - 10)
    log(s, { kind: 'system', faction: factionId, text: `${f.name} implements a draft. Manpower rises, but public support buckles.` })
  } else if (policy === 'emergency') {
    f.support = clamp(f.support - 2)
    log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} shifts to emergency rearmament.` })
  } else if (policy === 'contracts') {
    f.support = clamp(f.support - 1)
    log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} opens defense contracts to industry.` })
  } else {
    f.support = clamp(f.support + 1)
    log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} returns procurement to a civilian footing.` })
  }
  checkRegime(s)
  return s
}

export function setProcurementBurden(state: GameState, factionId: string, burden: ProcurementBurden): GameState {
  const s = clone(state)
  const f = s.factions[factionId]
  if (!f || f.exiled || f.procurement.burden === burden) return state
  f.procurement.burden = burden
  log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} sets procurement burden to ${burden}.` })
  return s
}

export function startProcurement(state: GameState, factionId: string, type: ProcurementProjectType): GameState {
  const s = clone(state)
  const f = s.factions[factionId]
  if (!f || f.exiled) return state
  const current = f.procurement.project
  if (current?.type === type) return state
  f.procurement.project = { type, progress: current ? Math.min(current.progress, PROJECT_COST[type] - 1) : 0 }
  log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} starts procurement for ${PROJECT_LABEL[type]}.` })
  return s
}

export function sendAidPackage(state: GameState, fromId: string, toId: string, type: AidPackageType): GameState {
  if (fromId === toId) return state
  const s = clone(state)
  const from = s.factions[fromId]
  const to = s.factions[toId]
  if (!from || !to || from.exiled || from.alignment === 'neutral' || from.alignment !== to.alignment) return state

  if (type === 'economic') {
    from.market = clamp(from.market - 6)
    from.support = clamp(from.support - 1)
    to.market = clamp(to.market + 8)
    to.support = clamp(to.support + 2)
    to.disposition = clamp(to.disposition + 10, -100, 100)
    to.procurement.aidBoost = Math.max(to.procurement.aidBoost, 15)
    to.procurement.aidBoostTurns = Math.max(to.procurement.aidBoostTurns, 3)
    if (to.procurement.policy === 'civilian') to.procurement.policy = 'contracts'
    if (!to.procurement.project) to.procurement.project = { type: 'missile_battery', progress: 0 }
    if (to.procurement.project) to.procurement.project.progress += 70
    log(s, { kind: 'dispatch', faction: fromId, text: `${from.name} sends economic aid to ${to.name}. Their factories surge and procurement jumps forward.` })
  } else {
    from.market = clamp(from.market - 4)
    to.disposition = clamp(to.disposition + 6, -100, 100)
    to.procurement.aidBoost = Math.max(to.procurement.aidBoost, 10)
    to.procurement.aidBoostTurns = Math.max(to.procurement.aidBoostTurns, 2)
    if (to.procurement.policy === 'civilian') to.procurement.policy = 'contracts'
    if (!to.procurement.project) to.procurement.project = { type: 'missile_battery', progress: 0 }
    if (to.procurement.project) to.procurement.project.progress += 45
    log(s, { kind: 'system', faction: fromId, text: `${from.name} ships arms to ${to.name}. Their build queue accelerates.` })
  }
  completeProcurementIfReady(s, toId)
  checkRegime(s)
  return s
}

function nextId<T extends { id: string }>(items: T[], prefix: string): string {
  let best = -1
  for (const item of items) {
    if (!item.id.startsWith(prefix)) continue
    const n = Number(item.id.slice(prefix.length))
    if (Number.isFinite(n)) best = Math.max(best, n)
  }
  return `${prefix}${best + 1}`
}

function ownedPlains(s: GameState, factionId: string): Hex[] {
  const cap = s.factions[factionId].capital
  return Object.values(s.tiles)
    .filter((t) => t.owner === factionId && t.terrain === 'plains')
    .map((t) => t.hex)
    .sort((a, b) => distance(a, cap) - distance(b, cap))
}

function openOwnedPlains(s: GameState, factionId: string, coastal = false): Hex | undefined {
  const occupied = new Set(s.installations.map((i) => key(i.hex)))
  return ownedPlains(s, factionId).find((h) => {
    if (occupied.has(key(h))) return false
    return !coastal || neighbors(h).some((n) => s.tiles[key(n)]?.terrain === 'sea')
  })
}

function forceStagingHex(s: GameState, factionId: string, type: ForceType): Hex | undefined {
  if (type === 'naval_group') {
    const base = s.installations.find((i) => i.owner === factionId && i.type === 'naval_base')
    if (base) return base.hex
    return Object.values(s.tiles)
      .filter((t) => t.terrain === 'sea' && neighbors(t.hex).some((n) => s.tiles[key(n)]?.owner === factionId))
      .map((t) => t.hex)[0]
  }
  const armyBase = s.installations.find((i) => i.owner === factionId && i.type === 'army_base')
  return armyBase?.hex ?? s.factions[factionId].capital ?? ownedPlains(s, factionId)[0]
}

function addForce(s: GameState, factionId: string, type: ForceType): boolean {
  const hex = forceStagingHex(s, factionId, type)
  if (!hex) return false
  const strength = type === 'army_group' ? (NEW_ARMY_STRENGTH[factionId] ?? NEW_FORCE_STRENGTH.army_group) : NEW_FORCE_STRENGTH[type]
  const force: Force = {
    id: nextId(s.forces, 'f'), owner: factionId, type, hex,
    health: NEW_FORCE_HEALTH[type], maxHealth: NEW_FORCE_HEALTH[type], strength, acted: true,
  }
  if (type === 'missile_battery' || type === 'naval_group') { force.charges = 2; force.maxCharges = 2 }
  s.forces.push(force)
  return true
}

function addBase(s: GameState, factionId: string, type: 'air_base' | 'naval_base'): boolean {
  const hex = openOwnedPlains(s, factionId, type === 'naval_base')
  if (!hex) return false
  const inst: Installation = { id: nextId(s.installations, 'i'), owner: factionId, type, hex, integrity: NEW_BASE_INTEGRITY[type] }
  if (type === 'air_base') { inst.charges = 2; inst.maxCharges = 2 }
  s.installations.push(inst)
  return true
}

function completeProcurementIfReady(s: GameState, factionId: string): boolean {
  const f = s.factions[factionId]
  const project = f?.procurement.project
  if (!f || !project || project.progress < PROJECT_COST[project.type]) return false
  let created = false
  if (project.type === 'air_base' || project.type === 'naval_base') created = addBase(s, factionId, project.type)
  else created = addForce(s, factionId, project.type)
  if (!created) {
    project.progress = PROJECT_COST[project.type] - 1
    log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} lacks a suitable site for ${PROJECT_LABEL[project.type]}.` })
    return false
  }
  log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} completes procurement: ${PROJECT_LABEL[project.type]} enters service.` })
  f.procurement.project = undefined
  return true
}

function processProcurement(s: GameState, factionId: string) {
  const f = s.factions[factionId]
  if (!f) return
  const p = f.procurement
  const rate = procurementRate(s, factionId)
  if (p.aidBoostTurns > 0) {
    p.aidBoostTurns -= 1
    if (p.aidBoostTurns <= 0) p.aidBoost = 0
  }
  if (!p.project || rate <= 0) return

  p.project.progress += rate
  const supportCost = Math.max(0, BURDEN_SUPPORT_COST[p.burden] + POLICY_SUPPORT_COST[p.policy])
  const economyCost = BURDEN_ECONOMY_COST[p.burden]
  f.market = clamp(f.market - economyCost)
  f.support = clamp(f.support - supportCost)
  log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} adds ${rate} procurement to ${PROJECT_LABEL[p.project.type]} (${Math.min(p.project.progress, PROJECT_COST[p.project.type])}/${PROJECT_COST[p.project.type]}).` })
  completeProcurementIfReady(s, factionId)
  checkRegime(s)
}

// --- Trade network -------------------------------------------------------

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

function requestSubjectPairKey(request: CeasefireRequest): string {
  return pairKey(request.to, request.counterpartId ?? request.from)
}

function peacePairAttemptedThisTurn(s: GameState, a: string, b: string): boolean {
  return (s.peacePairAttemptTurn?.[pairKey(a, b)] ?? -1) >= s.turn
}

function markPeacePairAttempt(s: GameState, a: string, b: string) {
  ensureDiplomacy(s)
  s.peacePairAttemptTurn![pairKey(a, b)] = s.turn
}

export function hasCeasefire(s: GameState, a: string, b: string): boolean {
  if (a === b) return false
  return (s.ceasefires ?? []).includes(pairKey(a, b))
}

export function isEmbargoed(s: GameState, a: string, b: string): boolean {
  return s.embargoes.includes(pairKey(a, b))
}

export function embargoOwner(s: GameState, a: string, b: string): string | undefined {
  return s.embargoedBy[pairKey(a, b)]
}

/** Market = how intact your cities are × how much of your trade network is open.
 *  Trade is weighted by partner size, so losing a big partner hurts far more. */
function recomputeMarket(s: GameState, id: string) {
  const cities = s.installations.filter((i) => i.type === 'city' && i.owner === id)
  const cityFactor = cities.length ? cities.reduce((a, c) => a + c.integrity, 0) / cities.length / 100 : 0
  let total = 0, open = 0
  for (const other of Object.values(s.factions)) {
    if (other.id === id) continue
    total += other.tradeWeight
    if (!isEmbargoed(s, id, other.id)) open += other.tradeWeight
  }
  const tradeFactor = total > 0 ? open / total : 1
  s.factions[id].market = Math.round(100 * cityFactor * tradeFactor)
}

function hasOwnedCity(s: GameState, id: string): boolean {
  return s.installations.some((i) => i.type === 'city' && i.owner === id)
}

function refreshGovernmentExile(s: GameState, id: string | null | undefined) {
  if (!id) return
  const faction = s.factions[id]
  if (!faction) return
  const controlsCity = hasOwnedCity(s, id)
  if (!controlsCity && !faction.exiled) {
    faction.exiled = true
    faction.exiledTurn = s.turn
    faction.procurement.project = undefined
    faction.procurement.aidBoost = 0
    faction.procurement.aidBoostTurns = 0
    log(s, {
      kind: 'system',
      faction: id,
      text: `${faction.name}'s government goes into exile after losing control of every city. It can issue statements and pursue diplomacy, but no longer commands national military or procurement actions.`,
    })
  } else if (controlsCity && faction.exiled) {
    faction.exiled = false
    faction.exiledTurn = undefined
    log(s, {
      kind: 'dispatch',
      faction: id,
      text: `${faction.name}'s government returns from exile after regaining a city.`,
    })
  }
}

function transferCitiesOnHex(s: GameState, hex: Hex, newOwner: string, prevOwner?: string | null) {
  let transferred = false
  for (const city of s.installations) {
    if (city.type !== 'city' || !hexEquals(city.hex, hex) || city.owner === newOwner) continue
    const oldOwner = city.owner
    city.owner = newOwner
    transferred = true
    log(s, {
      kind: 'system',
      faction: newOwner,
      text: `${s.factions[newOwner]?.name ?? newOwner} occupies ${s.factions[oldOwner]?.name ?? oldOwner}'s city at (${hex.q},${hex.r}).`,
    })
    recomputeMarket(s, oldOwner)
    refreshGovernmentExile(s, oldOwner)
  }
  if (transferred) {
    recomputeMarket(s, newOwner)
    refreshGovernmentExile(s, newOwner)
  }
  if (prevOwner && prevOwner !== newOwner) refreshGovernmentExile(s, prevOwner)
}

/** Cut or restore the (a,b) trade link. Both economies recompute; the hit to each
 *  is proportional to the *other's* size. A nation only controls its own links —
 *  a bloc-wide embargo requires convincing every nation independently. */
export function toggleEmbargo(state: GameState, a: string, b: string): GameState {
  if (a === b) return state
  const s = clone(state)
  if (s.factions[a]?.exiled) return state
  const k = pairKey(a, b)
  const idx = s.embargoes.indexOf(k)
  const cutting = idx === -1
  if (cutting) {
    s.embargoes.push(k)
    s.embargoedBy[k] = a
  } else {
    const owner = s.embargoedBy[k]
    if (owner && owner !== a) return state
    s.embargoes.splice(idx, 1)
    delete s.embargoedBy[k]
  }
  recomputeMarket(s, a)
  recomputeMarket(s, b)
  const A = s.factions[a].name, B = s.factions[b].name
  if (cutting) {
    s.factions[b].disposition = clamp(s.factions[b].disposition - 6, -100, 100)
    log(s, { kind: 'dispatch', faction: a, text: `${A} embargoes ${B}. ${B}'s economy falls to ${s.factions[b].market}; ${A}'s to ${s.factions[a].market}.` })
  } else {
    s.factions[b].disposition = clamp(s.factions[b].disposition + 4, -100, 100)
    log(s, { kind: 'dispatch', faction: a, text: `${A} restores trade with ${B}.` })
  }
  checkRegime(s)
  return s
}

export function sendDiplomaticMessage(state: GameState, fromId: string, toId: string, message: string): GameState {
  if (fromId === toId) return state
  const text = cleanDiplomaticMessage(message)
  if (!text) return state
  const s = clone(state)
  ensureDiplomacy(s)
  const from = s.factions[fromId]
  const to = s.factions[toId]
  if (!from || !to) return state
  s.diplomaticMessages.unshift({ id: nextDiplomacyId(s, 'm'), from: fromId, to: toId, message: text, turn: s.turn, kind: 'message' })
  s.diplomaticMessages = s.diplomaticMessages.slice(0, 80)
  log(s, { kind: 'dispatch', faction: fromId, text: `${from.name} sends ${to.name} a diplomatic message: "${text}"` })
  return s
}

export function returnableLand(state: GameState, factionId: string): Array<{ hex: Hex; to: string }> {
  return Object.values(state.tiles)
    .filter((tile) => tile.owner === factionId && !!tile.lastOwner && tile.lastOwner !== factionId && !!state.factions[tile.lastOwner])
    .map((tile) => ({ hex: tile.hex, to: tile.lastOwner as string }))
}

function peaceTermsForHexes(s: GameState, fromId: string, returnHexes: Hex[] = [], forcedToId?: string): PeaceTerm[] {
  const terms: PeaceTerm[] = []
  const seen = new Set<string>()
  for (const hex of returnHexes) {
    const tile = s.tiles[key(hex)]
    if (!tile || tile.owner !== fromId || !tile.lastOwner || tile.lastOwner === fromId) continue
    const to = forcedToId ?? tile.lastOwner
    if (forcedToId && tile.lastOwner !== forcedToId) continue
    if (!s.factions[to]) continue
    const termKey = key(hex)
    if (seen.has(termKey)) continue
    seen.add(termKey)
    terms.push({ type: 'return_land', hex: tile.hex, from: fromId, to })
  }
  return terms
}

function applyPeaceTerms(s: GameState, terms: PeaceTerm[] = []) {
  for (const term of terms) {
    if (term.type !== 'return_land') continue
    const tile = s.tiles[key(term.hex)]
    if (!tile || tile.owner !== term.from || !s.factions[term.to]) continue
    tile.owner = term.to
    tile.lastOwner = term.from
    tile.contested = true
    transferCitiesOnHex(s, term.hex, term.to, term.from)
    log(s, {
      kind: 'dispatch',
      faction: term.from,
      text: `${s.factions[term.from]?.name ?? term.from} returns (${term.hex.q},${term.hex.r}) to ${s.factions[term.to]?.name ?? term.to} as part of a peace settlement.`,
    })
  }
}

function hasOpenPeaceRequestForPair(s: GameState, a: string, b: string): boolean {
  const pair = pairKey(a, b)
  return (s.ceasefireRequests ?? []).some((request) => requestSubjectPairKey(request) === pair)
}

function canAttemptPeaceForPair(s: GameState, a: string, b: string): boolean {
  return a !== b && !hasCeasefire(s, a, b) && !hasOpenPeaceRequestForPair(s, a, b) && !peacePairAttemptedThisTurn(s, a, b)
}

export function proposeCeasefire(state: GameState, fromId: string, toId: string, message: string): GameState {
  if (!canAttemptPeaceForPair(state, fromId, toId)) return state
  const text = cleanDiplomaticMessage(message)
  if (!text) return state
  const s = clone(state)
  ensureDiplomacy(s)
  const from = s.factions[fromId]
  const to = s.factions[toId]
  if (!from || !to) return state
  if (!canAttemptPeaceForPair(s, fromId, toId)) return state
  markPeacePairAttempt(s, fromId, toId)
  const request: CeasefireRequest = { id: nextDiplomacyId(s, 'cf'), from: fromId, to: toId, message: text, turn: s.turn, kind: 'ceasefire' }
  s.ceasefireRequests.unshift(request)
  s.diplomaticMessages.unshift({ ...request, kind: 'ceasefire_request' })
  s.diplomaticMessages = s.diplomaticMessages.slice(0, 80)
  log(s, { kind: 'dispatch', faction: fromId, text: `${from.name} asks ${to.name} for a ceasefire: "${text}"` })
  return s
}

export function proposePeace(
  state: GameState,
  fromId: string,
  toId: string,
  message: string,
  returnHexes: Hex[] = [],
): GameState {
  if (!canAttemptPeaceForPair(state, fromId, toId)) return state
  const text = cleanDiplomaticMessage(message)
  if (!text) return state
  const s = clone(state)
  ensureDiplomacy(s)
  const from = s.factions[fromId]
  const to = s.factions[toId]
  if (!from || !to) return state
  if (!canAttemptPeaceForPair(s, fromId, toId)) return state
  markPeacePairAttempt(s, fromId, toId)
  const terms = peaceTermsForHexes(s, fromId, returnHexes, toId)
  const request: CeasefireRequest = { id: nextDiplomacyId(s, 'cf'), from: fromId, to: toId, message: text, turn: s.turn, kind: 'peace_offer', terms }
  s.ceasefireRequests.unshift(request)
  s.diplomaticMessages.unshift({ ...request, kind: 'peace_offer' })
  s.diplomaticMessages = s.diplomaticMessages.slice(0, 80)
  const termText = terms.length ? ` Terms: ${terms.map((term) => `return (${term.hex.q},${term.hex.r})`).join(', ')}.` : ''
  log(s, { kind: 'dispatch', faction: fromId, text: `${from.name} offers ${to.name} a peace settlement: "${text}"${termText}` })
  return s
}

export function mediatePeace(
  state: GameState,
  mediatorId: string,
  sideAId: string,
  sideBId: string,
  message: string,
  returnHexes: Hex[] = [],
): GameState {
  if (!canAttemptPeaceForPair(state, sideAId, sideBId)) return state
  const text = cleanDiplomaticMessage(message)
  if (!text) return state
  const s = clone(state)
  ensureDiplomacy(s)
  const mediator = s.factions[mediatorId]
  const sideA = s.factions[sideAId]
  const sideB = s.factions[sideBId]
  if (!mediator || !sideA || !sideB) return state
  if (!canAttemptPeaceForPair(s, sideAId, sideBId)) return state
  markPeacePairAttempt(s, sideAId, sideBId)
  const terms = peaceTermsForHexes(s, sideBId, returnHexes, sideAId)
  const request: CeasefireRequest = {
    id: nextDiplomacyId(s, 'cf'),
    from: mediatorId,
    to: sideAId,
    counterpartId: sideBId,
    message: text,
    turn: s.turn,
    kind: 'mediation',
    terms,
  }
  s.ceasefireRequests.unshift(request)
  s.diplomaticMessages.unshift({ ...request, kind: 'mediation_offer' })
  s.diplomaticMessages = s.diplomaticMessages.slice(0, 80)
  const termText = terms.length ? ` Terms: ${terms.map((term) => `${s.factions[term.from]?.name ?? term.from} returns (${term.hex.q},${term.hex.r})`).join(', ')}.` : ''
  log(s, { kind: 'dispatch', faction: mediatorId, text: `${mediator.name} asks ${sideA.name} to accept mediated peace with ${sideB.name}: "${text}"${termText}` })
  return s
}

export function returnLand(state: GameState, fromId: string, hex: Hex, toId: string): GameState {
  const s = clone(state)
  const tile = s.tiles[key(hex)]
  if (!tile || tile.owner !== fromId || tile.lastOwner !== toId || !s.factions[fromId] || !s.factions[toId]) return state
  applyPeaceTerms(s, [{ type: 'return_land', hex: tile.hex, from: fromId, to: toId }])
  return s
}

export function respondCeasefire(
  state: GameState,
  responderId: string,
  requestId: string,
  response: CeasefireResponse,
  message = '',
): GameState {
  const s = clone(state)
  ensureDiplomacy(s)
  const request = s.ceasefireRequests.find((item) => item.id === requestId && item.to === responderId)
  if (!request) return state
  if (request.kind === 'mediation') return state
  const responder = s.factions[responderId]
  const requester = s.factions[request.from]
  if (!responder || !requester) return state
  s.ceasefireRequests = s.ceasefireRequests.filter((item) => item.id !== requestId)
  const text = cleanDiplomaticMessage(message) || (response === 'accepted'
    ? 'We accept a ceasefire and will suspend hostile operations.'
    : 'We reject a ceasefire under the current conditions.')
  if (response === 'accepted') {
    const otherSide = request.counterpartId ?? request.from
    const k = pairKey(responderId, otherSide)
    if (!s.ceasefires.includes(k)) s.ceasefires.push(k)
    applyPeaceTerms(s, request.terms)
  }
  s.diplomaticMessages.unshift({
    id: nextDiplomacyId(s, 'm'),
    from: responderId,
    to: request.from,
    message: text,
    turn: s.turn,
    kind: 'ceasefire_response',
    response,
  })
  s.diplomaticMessages = s.diplomaticMessages.slice(0, 80)
  const subject = request.kind === 'peace_offer'
    ? `${requester.name}'s peace offer`
    : `${requester.name}'s ceasefire request`
  log(s, {
    kind: 'dispatch',
    faction: responderId,
    text: response === 'accepted'
      ? `${responder.name} accepts ${subject}; both governments enter a bilateral ceasefire: "${text}"`
      : `${responder.name} rejects ${subject}: "${text}"`,
  })
  return s
}

export function respondMediation(
  state: GameState,
  requestId: string,
  sideAResponse: CeasefireResponse,
  sideAMessage: string,
  sideBResponse: CeasefireResponse,
  sideBMessage: string,
): GameState {
  const s = clone(state)
  ensureDiplomacy(s)
  const request = s.ceasefireRequests.find((item) => item.id === requestId && item.kind === 'mediation' && item.counterpartId)
  if (!request?.counterpartId) return state
  const mediator = s.factions[request.from]
  const sideA = s.factions[request.to]
  const sideB = s.factions[request.counterpartId]
  if (!mediator || !sideA || !sideB) return state

  s.ceasefireRequests = s.ceasefireRequests.filter((item) => item.id !== requestId)
  const aText = cleanDiplomaticMessage(sideAMessage) || (sideAResponse === 'accepted'
    ? 'We accept the mediated peace proposal.'
    : 'We reject the mediated peace proposal under the current conditions.')
  const bText = cleanDiplomaticMessage(sideBMessage) || (sideBResponse === 'accepted'
    ? 'We accept the mediated peace proposal.'
    : 'We reject the mediated peace proposal under the current conditions.')

  if (sideAResponse === 'accepted' && sideBResponse === 'accepted') {
    const k = pairKey(sideA.id, sideB.id)
    if (!s.ceasefires.includes(k)) s.ceasefires.push(k)
    applyPeaceTerms(s, request.terms)
  }

  s.diplomaticMessages.unshift({
    id: nextDiplomacyId(s, 'm'),
    from: sideA.id,
    to: request.from,
    message: aText,
    turn: s.turn,
    kind: 'ceasefire_response',
    response: sideAResponse,
  })
  s.diplomaticMessages.unshift({
    id: nextDiplomacyId(s, 'm'),
    from: sideB.id,
    to: request.from,
    message: bText,
    turn: s.turn,
    kind: 'ceasefire_response',
    response: sideBResponse,
  })
  s.diplomaticMessages = s.diplomaticMessages.slice(0, 80)

  log(s, {
    kind: 'dispatch',
    faction: sideA.id,
    text: `${sideA.name} ${sideAResponse === 'accepted' ? 'accepts' : 'rejects'} ${mediator.name}'s mediated peace proposal with ${sideB.name}: "${aText}"`,
  })
  log(s, {
    kind: 'dispatch',
    faction: sideB.id,
    text: `${sideB.name} ${sideBResponse === 'accepted' ? 'accepts' : 'rejects'} ${mediator.name}'s mediated peace proposal with ${sideA.name}: "${bText}"`,
  })
  if (sideAResponse === 'accepted' && sideBResponse === 'accepted') {
    log(s, { kind: 'dispatch', faction: request.from, text: `${mediator.name}'s mediation succeeds: ${sideA.name} and ${sideB.name} enter a ceasefire.` })
  } else {
    log(s, { kind: 'dispatch', faction: request.from, text: `${mediator.name}'s mediation fails: ${sideA.name} and ${sideB.name} do not both accept.` })
  }
  return s
}

function checkRegime(s: GameState) {
  if (s.regimeFallen) return
  const crises = s.supportCrises ??= []
  for (const f of Object.values(s.factions)) {
    if (f.support <= 0 && !crises.includes(f.id)) {
      crises.push(f.id)
      log(s, { kind: 'system', faction: f.id, text: `${f.name}'s government enters a legitimacy crisis - domestic support has hit zero. The crisis continues, but public pressure now demands a political course correction.` })
      return
    }
  }
}

export function applyPublicSupportDelta(state: GameState, factionId: string, delta: number): GameState {
  const s = clone(state)
  const f = s.factions[factionId]
  if (!f || !Number.isFinite(delta)) return state
  f.support = clamp(f.support + Math.round(delta))
  checkRegime(s)
  return s
}

/** Apply a strike to the target hex. A friendly garrison base shields any forces
 *  on the tile (the base soaks the hit until destroyed). Caller spends charges. */
function applyStrike(s: GameState, atkId: string, target: Hex, kind: StrikeKind, intensity: StrikeIntensity) {
  const tkey = key(target)
  const mine = s.factions[atkId].alignment
  const me = s.factions[atkId].name
  const verb = `${me} lands a ${intensity} ${KIND_LABEL[kind]}`
  const canTarget = (ownerId: string) => s.factions[ownerId].alignment !== mine && !hasCeasefire(s, atkId, ownerId)
  const enemyInst = (pred: (i: Installation) => boolean) =>
    s.installations.find((i) => key(i.hex) === tkey && canTarget(i.owner) && pred(i))
  const enemyForce = s.forces.find((f) => key(f.hex) === tkey && canTarget(f.owner))
  const shield = enemyInst((i) => PROTECTING.includes(i.type))

  // Priority: a protecting base shields forces; else a force; else a soft installation.
  const inst = shield ?? (enemyForce ? undefined : enemyInst(() => true))

  if (inst) {
    const owner = s.factions[inst.owner]
    const before = inst.integrity
    const damage = Math.min(before, rollStruct(kind, intensity))
    inst.integrity = Math.max(0, before - damage)
    const destroyed = inst.type !== 'city' && inst.integrity <= 0
    const deaths = addDeaths(s, inst.owner, installationDeaths(inst.type, damage, intensity, destroyed))
    if (inst.type === 'city') {
      recomputeMarket(s, inst.owner)
      owner.support = clamp(owner.support + (intensity === 'full' ? 12 : 8)) // rally-round-the-flag
      owner.disposition = clamp(owner.disposition - 12, -100, 100)
      log(s, { kind: 'dispatch', faction: atkId, text: `${verb} on a ${owner.name} city (integrity ${inst.integrity}%). Outrage rallies its people behind their government; the economy reels.${deathNote(deaths)}` })
    } else {
      owner.disposition = clamp(owner.disposition - 8, -100, 100)
      const garrisoned = shield === inst && !!enemyForce
      if (inst.integrity <= 0) {
        s.installations = s.installations.filter((i) => i.id !== inst.id)
        log(s, { kind: 'dispatch', faction: atkId, text: `${verb} on ${owner.name}'s ${inst.type.replace('_', ' ')} — destroyed.${deathNote(deaths)}` })
      } else {
        log(s, { kind: 'dispatch', faction: atkId, text: `${verb} on ${owner.name}'s ${inst.type.replace('_', ' ')} (integrity ${inst.integrity}%${garrisoned ? ', shielding its garrison' : ''}).${deathNote(deaths)}` })
      }
    }
    return
  }

  if (enemyForce) {
    // Civ-style combat roll. Effectiveness vs ARMY: air devastating, missile/naval weak.
    const factor = enemyForce.type === 'army_group' ? (kind === 'air' ? 1.6 : 0.5) : 1
    const before = enemyForce.health
    const damage = Math.min(before, Math.round(rollCombat(kind, intensity) * factor))
    enemyForce.health -= damage
    const on = s.factions[enemyForce.owner].name
    const destroyed = enemyForce.health <= 0
    const deaths = addDeaths(s, enemyForce.owner, forceDeaths(enemyForce.type, damage, destroyed))
    if (enemyForce.health <= 0) {
      s.forces = s.forces.filter((f) => f.id !== enemyForce.id)
      log(s, { kind: 'dispatch', faction: atkId, text: `${verb} on ${on}'s ${forceNoun(enemyForce.type)} — destroyed.${deathNote(deaths)}` })
    } else {
      log(s, { kind: 'dispatch', faction: atkId, text: `${verb} on ${on}'s ${forceNoun(enemyForce.type)} (now ${enemyForce.health} HP).${deathNote(deaths)}` })
    }
    s.factions[enemyForce.owner].disposition = clamp(s.factions[enemyForce.owner].disposition - 6, -100, 100)
  }
}

export function forceStrike(state: GameState, forceId: string, target: Hex, intensity: StrikeIntensity): GameState {
  const s = clone(state)
  const force = s.forces.find((f) => f.id === forceId)
  if (!force || s.factions[force.owner]?.exiled || !canStrike(force) || (force.charges ?? 0) < chargeCost(intensity)) return state
  if (!strikeTargets(s, force).some((h) => hexEquals(h, target))) return state
  applyStrike(s, force.owner, target, kindOf(force), intensity)
  force.charges = (force.charges ?? 0) - chargeCost(intensity)
  force.acted = true
  checkRegime(s)
  return s
}

/** Launch an air strike from a specific air base. */
export function airStrike(state: GameState, baseId: string, target: Hex, intensity: StrikeIntensity): GameState {
  const s = clone(state)
  const base = s.installations.find((i) => i.id === baseId)
  if (!base || base.type !== 'air_base' || s.factions[base.owner]?.exiled) return state
  const cost = chargeCost(intensity)
  if ((base.charges ?? 0) < cost) return state
  if (!airBaseTargets(s, baseId).some((h) => hexEquals(h, target))) return state
  applyStrike(s, base.owner, target, 'air', intensity)
  base.charges = (base.charges ?? 0) - cost
  checkRegime(s)
  return s
}

/** Restock a faction's strike platforms: missile/naval refill when on/adjacent a
 *  friendly base; air bases regenerate sorties. Called as the faction's turn begins. */
function restock(s: GameState, factionId: string) {
  for (const f of s.forces) {
    if (f.owner !== factionId) continue
    f.acted = false
    if (f.type !== 'missile_battery' && f.type !== 'naval_group') continue
    const nearBase = s.installations.some(
      (i) => i.owner === factionId && (hexEquals(i.hex, f.hex) || neighbors(f.hex).some((n) => hexEquals(n, i.hex))),
    )
    if (nearBase) f.charges = f.maxCharges ?? 2
  }
  for (const i of s.installations) if (i.type === 'air_base' && i.owner === factionId) i.charges = i.maxCharges ?? 2
}

// --- Turn flow ------------------------------------------------------------

export function endFactionTurn(state: GameState): GameState {
  const s = clone(state)
  s.turnIndex += 1
  if (s.turnIndex >= s.order.length) {
    s.turnIndex = 0
    s.turn += 1
    log(s, { kind: 'system', text: `Round ${s.turn} begins.` })
  }
  const next = s.factions[currentFactionId(s)]
  if (next.exiled) {
    log(s, { kind: 'system', faction: next.id, text: `${next.name}'s government-in-exile turn.` })
  } else {
    restock(s, next.id) // resupply the incoming faction's strike platforms
    processProcurement(s, next.id)
    log(s, { kind: 'system', faction: next.id, text: `${next.name}'s turn.` })
  }
  return s
}

// --- Action layer (LLM / agent interface) ---------------------------------
//
// Every valid thing a faction can do on its turn is representable as an Action.
// `availableActions` enumerates them all; `dispatch` executes any one of them.
// Both operate purely on GameState — no UI state required. The mouse-driven
// store is just one consumer of this layer; an LLM agent is another.

export type Action =
  | { type: 'move_force';             forceId: string; to: Hex }
  | { type: 'claim_hex';              forceId: string }
  | { type: 'force_strike';           forceId: string; target: Hex; intensity: StrikeIntensity }
  | { type: 'air_strike';             baseId: string;  target: Hex; intensity: StrikeIntensity }
  | { type: 'set_procurement_policy'; policy: ProcurementPolicy }
  | { type: 'set_procurement_burden'; burden: ProcurementBurden }
  | { type: 'start_procurement';      projectType: ProcurementProjectType }
  | { type: 'send_aid';               targetId: string; aidType: AidPackageType }
  | { type: 'toggle_trade';           targetId: string }
  | { type: 'send_message';           targetId: string; message: string }
  | { type: 'propose_ceasefire';      targetId: string; message: string }
  | { type: 'propose_peace';          targetId: string; message: string; returnHexes?: Hex[] }
  | { type: 'mediate_peace';          sideAId: string; sideBId: string; message: string; returnHexes?: Hex[] }
  | { type: 'return_land';            hex: Hex; toId: string }
  | { type: 'respond_ceasefire';      requestId: string; response: CeasefireResponse; message: string }
  | { type: 'end_turn' }

function exileActions(state: GameState, factionId: string): Action[] {
  const actions: Action[] = []
  const factions = Object.values(state.factions)
  for (const other of factions) {
    if (other.id === factionId) continue
    actions.push({ type: 'send_message', targetId: other.id, message: '' })
    if (canAttemptPeaceForPair(state, factionId, other.id)) {
      actions.push({ type: 'propose_ceasefire', targetId: other.id, message: '' })
      actions.push({ type: 'propose_peace', targetId: other.id, message: '', returnHexes: [] })
    }
  }
  for (const sideA of factions) {
    if (sideA.id === factionId) continue
    for (const sideB of factions) {
      if (sideB.id === factionId || sideB.id === sideA.id || !canAttemptPeaceForPair(state, sideA.id, sideB.id)) continue
      actions.push({ type: 'mediate_peace', sideAId: sideA.id, sideBId: sideB.id, message: '', returnHexes: [] })
    }
  }
  actions.push({ type: 'end_turn' })
  return actions
}

function isExileAction(action: Action): boolean {
  return (
    action.type === 'send_message' ||
    action.type === 'propose_ceasefire' ||
    action.type === 'propose_peace' ||
    action.type === 'mediate_peace' ||
    action.type === 'respond_ceasefire' ||
    action.type === 'end_turn'
  )
}

/** Every action the current faction can legally take right now.
 *  Returns a flat, serializable list suitable for LLM tool-call enumeration. */
export function availableActions(state: GameState): Action[] {
  if (state.regimeFallen) return []
  const factionId = currentFactionId(state)
  const faction = state.factions[factionId]
  const actions: Action[] = []
  const pendingCeasefires = (state.ceasefireRequests ?? []).filter((request) => request.to === factionId)
  if (pendingCeasefires.length > 0) {
    for (const request of pendingCeasefires) {
      actions.push({ type: 'respond_ceasefire', requestId: request.id, response: 'accepted', message: '' })
      actions.push({ type: 'respond_ceasefire', requestId: request.id, response: 'rejected', message: '' })
    }
    return actions
  }
  if (faction.exiled) return exileActions(state, factionId)
  // --- Forces ---
  for (const force of state.forces) {
    if (force.owner !== factionId || force.acted) continue
    for (const to of legalMoves(state, force))
      actions.push({ type: 'move_force', forceId: force.id, to })
    if (canClaim(state, force))
      actions.push({ type: 'claim_hex', forceId: force.id })
    if (canStrike(force)) {
      for (const target of strikeTargets(state, force)) {
        actions.push({ type: 'force_strike', forceId: force.id, target, intensity: 'limited' })
        if ((force.charges ?? 0) >= 2)
          actions.push({ type: 'force_strike', forceId: force.id, target, intensity: 'full' })
      }
    }
  }

  // --- Air bases ---
  for (const base of state.installations) {
    if (base.type !== 'air_base' || base.owner !== factionId || (base.charges ?? 0) < 1) continue
    for (const target of airBaseTargets(state, base.id)) {
      actions.push({ type: 'air_strike', baseId: base.id, target, intensity: 'limited' })
      if ((base.charges ?? 0) >= 2)
        actions.push({ type: 'air_strike', baseId: base.id, target, intensity: 'full' })
    }
  }

  // --- Procurement ---
  const proc = faction.procurement
  const policies: ProcurementPolicy[] = ['civilian', 'contracts', 'emergency', 'draft']
  for (const policy of policies)
    if (policy !== proc.policy) actions.push({ type: 'set_procurement_policy', policy })
  const burdens: ProcurementBurden[] = ['low', 'standard', 'high', 'crisis']
  for (const burden of burdens)
    if (burden !== proc.burden) actions.push({ type: 'set_procurement_burden', burden })
  const projectTypes: ProcurementProjectType[] = ['army_group', 'missile_battery', 'naval_group', 'air_base', 'naval_base']
  for (const projectType of projectTypes)
    if (proc.project?.type !== projectType) actions.push({ type: 'start_procurement', projectType })

  // --- Diplomacy ---
  if (faction.alignment !== 'neutral') {
    for (const other of Object.values(state.factions)) {
      if (other.id === factionId || other.alignment !== faction.alignment) continue
      actions.push({ type: 'send_aid', targetId: other.id, aidType: 'economic' })
      actions.push({ type: 'send_aid', targetId: other.id, aidType: 'arms' })
    }
  }
  for (const other of Object.values(state.factions)) {
    if (other.id === factionId) continue
    actions.push({ type: 'send_message', targetId: other.id, message: '' })
    if (canAttemptPeaceForPair(state, factionId, other.id)) {
      actions.push({ type: 'propose_ceasefire', targetId: other.id, message: '' })
      actions.push({ type: 'propose_peace', targetId: other.id, message: '', returnHexes: [] })
    }
    const embargoed = isEmbargoed(state, factionId, other.id)
    if (!embargoed || embargoOwner(state, factionId, other.id) === factionId)
      actions.push({ type: 'toggle_trade', targetId: other.id })
  }
  for (const land of returnableLand(state, factionId)) {
    actions.push({ type: 'return_land', hex: land.hex, toId: land.to })
  }
  const factions = Object.values(state.factions)
  for (const sideA of factions) {
    if (sideA.id === factionId) continue
    for (const sideB of factions) {
      if (sideB.id === factionId || sideB.id === sideA.id || !canAttemptPeaceForPair(state, sideA.id, sideB.id)) continue
      actions.push({ type: 'mediate_peace', sideAId: sideA.id, sideBId: sideB.id, message: '', returnHexes: [] })
    }
  }

  actions.push({ type: 'end_turn' })
  return actions
}

/** Execute a single action for the current faction. Returns a new GameState.
 *  Returns the same state reference (no-op) if the action is invalid. */
export function dispatch(state: GameState, action: Action): GameState {
  if (state.regimeFallen && action.type !== 'end_turn') return state
  const factionId = currentFactionId(state)
  if (state.factions[factionId]?.exiled && !isExileAction(action)) return state
  switch (action.type) {
    case 'move_force':             return moveForce(state, action.forceId, action.to)
    case 'claim_hex':              return claimHex(state, action.forceId)
    case 'force_strike':           return forceStrike(state, action.forceId, action.target, action.intensity)
    case 'air_strike':             return airStrike(state, action.baseId, action.target, action.intensity)
    case 'set_procurement_policy': return setProcurementPolicy(state, factionId, action.policy)
    case 'set_procurement_burden': return setProcurementBurden(state, factionId, action.burden)
    case 'start_procurement':      return startProcurement(state, factionId, action.projectType)
    case 'send_aid':               return sendAidPackage(state, factionId, action.targetId, action.aidType)
    case 'toggle_trade':           return toggleEmbargo(state, factionId, action.targetId)
    case 'send_message':           return sendDiplomaticMessage(state, factionId, action.targetId, action.message)
    case 'propose_ceasefire':      return proposeCeasefire(state, factionId, action.targetId, action.message)
    case 'propose_peace':          return proposePeace(state, factionId, action.targetId, action.message, action.returnHexes)
    case 'mediate_peace':          return mediatePeace(state, factionId, action.sideAId, action.sideBId, action.message, action.returnHexes)
    case 'return_land':            return returnLand(state, factionId, action.hex, action.toId)
    case 'respond_ceasefire':      return respondCeasefire(state, factionId, action.requestId, action.response, action.message)
    case 'end_turn':               return endFactionTurn(state)
    default:                       return state
  }
}
