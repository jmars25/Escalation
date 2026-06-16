// Pure-ish game logic. Each function takes the current state and returns a new
// one (we deep-clone, then mutate the clone). State is plain data, so
// structuredClone is safe and keeps call sites simple.
//
// There is no AI: the game is hotseat. `endFactionTurn` simply advances to the
// next nation in `order`. In Phase 3 that seam is where a Claude agent takes a
// faction's turn instead of the human.

import type {
  AidPackageType, Alignment, Force, ForceType, GameState, Hex, Installation, InstallationType,
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
    if (t.terrain === 'sea' || t.terrain === 'island') return true
    return s.installations.some((i) => i.type === 'naval_base' && i.owner === force.owner && hexEquals(i.hex, h))
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

function isAdjacent(a: Hex, b: Hex): boolean {
  return neighbors(a).some((n) => hexEquals(n, b))
}

function isDeployTarget(s: GameState, force: Force, h: Hex): boolean {
  if (force.acted || hexEquals(force.hex, h) || !canEnter(s, force, h)) return false
  const t = s.tiles[key(h)]
  if (!t) return false
  if (tileDefenders(s, h, s.factions[force.owner].alignment).length > 0) return false
  if (force.type === 'naval_group') {
    if (t.terrain === 'sea' || t.terrain === 'island') return true
    return t.owner === force.owner // docking at own naval base on land
  }
  return t.owner === force.owner
}

function isArmyAttackTarget(s: GameState, force: Force, h: Hex): boolean {
  if (force.acted || force.type !== 'army_group' || !isAdjacent(force.hex, h) || !canEnter(s, force, h)) return false
  const t = s.tiles[key(h)]
  if (!t) return false
  const mine = s.factions[force.owner].alignment
  return t.owner !== force.owner || !!t.disputedBy || !!t.dmz || tileDefenders(s, h, mine).length > 0
}

function isNavalAssaultTarget(s: GameState, force: Force, h: Hex): boolean {
  if (force.acted || force.type !== 'naval_group' || !isAdjacent(force.hex, h) || !canEnter(s, force, h)) return false
  const t = s.tiles[key(h)]
  if (!t || t.terrain !== 'island') return false
  return tileDefenders(s, h, s.factions[force.owner].alignment).length > 0
}

/** Legal actions for a force: deploy anywhere reachable, or for armies/navies,
 *  assault adjacent contested ground. Both consume the force's turn. */
export function legalMoves(s: GameState, force: Force): Hex[] {
  if (force.acted) return []
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
function tileDefenders(s: GameState, to: Hex, attackerAlign: Alignment): Defender[] {
  const enemy = (id: string) => s.factions[id].alignment !== attackerAlign
  const out: Defender[] = []
  for (const f of s.forces) {
    if (!hexEquals(f.hex, to) || !enemy(f.owner)) continue
    if (f.type === 'army_group' || f.type === 'naval_group') out.push({ kind: 'force', force: f, defStrength: f.strength })
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
  const isLandClaim = force.type === 'army_group' && t.terrain === 'plains'
  const isIslandClaim = force.type === 'naval_group' && t.terrain === 'island'
  if (!isLandClaim && !isIslandClaim) return false
  const prevOwner = t.owner
  const wasDmz = t.dmz
  t.owner = force.owner
  t.dmz = false
  t.disputedBy = undefined
  t.contested = true
  s.escalation = clamp(s.escalation + (wasDmz ? 14 : 8))
  if (prevOwner) s.factions[prevOwner].disposition = clamp(s.factions[prevOwner].disposition - 10, -100, 100)
  force.acted = true
  log(s, {
    kind: 'escalation', faction: force.owner,
    text: wasDmz
      ? `${s.factions[force.owner].name} claims the demilitarized zone by force - a blatant provocation.`
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
  if (!atk || atk.type !== 'army_group' || atk.acted) return state
  if (!isArmyAttackTarget(s, atk, to)) return state
  const mine = s.factions[atk.owner].alignment
  const defs = tileDefenders(s, to, mine)
  if (!defs.length) return state
  atk.acted = true
  const d = defs.sort((a, b) => b.defStrength - a.defStrength)[0]

  const effA = atk.strength * healthFactor(atk)
  const effD = d.kind === 'force' ? d.defStrength * healthFactor(d.force) : d.defStrength
  const r = () => 0.75 + Math.random() * 0.5
  const dmgToAtk = clamp(Math.round(16 * (effD / effA) * r()), 1, 100)
  const dmgRoll = clamp(Math.round(16 * (effA / effD) * r()), 1, 100)
  atk.health -= dmgToAtk

  let defName: string
  let ownerId: string
  let unit: string
  let dmgToDef: number
  if (d.kind === 'force') {
    dmgToDef = Math.min(dmgRoll, d.force.health)
    d.force.health -= dmgToDef
    defName = forceNoun(d.force.type); ownerId = d.force.owner; unit = ' HP'
    if (d.force.health <= 0) s.forces = s.forces.filter((f) => f.id !== d.force.id)
  } else {
    dmgToDef = Math.min(dmgRoll, d.inst.integrity)
    d.inst.integrity = Math.max(0, d.inst.integrity - dmgToDef)
    defName = d.inst.type.replace('_', ' '); ownerId = d.inst.owner; unit = '% integrity'
    if (d.inst.type === 'city') recomputeMarket(s, d.inst.owner)
    else if (d.inst.integrity <= 0) s.installations = s.installations.filter((i) => i.id !== d.inst.id)
  }

  const atkDead = atk.health <= 0
  if (atkDead) s.forces = s.forces.filter((f) => f.id !== atk.id)
  const cleared = !atkDead && tileDefenders(s, to, mine).length === 0
  let outcome: string
  if (cleared) {
    atk.hex = to
    const claimed = claimOccupiedHex(s, atk)
    outcome = claimed ? 'and claims the position' : 'and seizes the position'
  }
  else if (atkDead) outcome = 'and is wiped out'
  else outcome = 'but the position holds'

  s.escalation = clamp(s.escalation + 6)
  s.factions[ownerId].disposition = clamp(s.factions[ownerId].disposition - 6, -100, 100)
  log(s, { kind: 'escalation', faction: atk.owner, text: `${s.factions[atk.owner].name}'s army assaults ${s.factions[ownerId].name}'s ${defName} (−${dmgToDef}${unit}), taking −${dmgToAtk} HP ${outcome}.` })
  checkRegime(s)
  return s
}

/** Naval assault on a defended island — same Civ-style HP combat as a ground assault,
 *  but only naval groups fight over island terrain. Island is claimed once defenders clear. */
export function resolveNavalAssault(state: GameState, attackerId: string, to: Hex): GameState {
  const s = clone(state)
  const atk = s.forces.find((f) => f.id === attackerId)
  if (!atk || atk.type !== 'naval_group' || atk.acted) return state
  if (!isNavalAssaultTarget(s, atk, to)) return state
  const mine = s.factions[atk.owner].alignment
  const defs = tileDefenders(s, to, mine)
  if (!defs.length) return state
  atk.acted = true
  const d = defs.sort((a, b) => b.defStrength - a.defStrength)[0]

  const effA = atk.strength * healthFactor(atk)
  const effD = d.kind === 'force' ? d.defStrength * healthFactor(d.force) : d.defStrength
  const r = () => 0.75 + Math.random() * 0.5
  const dmgToAtk = clamp(Math.round(16 * (effD / effA) * r()), 1, 100)
  const dmgRoll = clamp(Math.round(16 * (effA / effD) * r()), 1, 100)
  atk.health -= dmgToAtk

  let defName: string
  let ownerId: string
  let unit: string
  let dmgToDef: number
  if (d.kind === 'force') {
    dmgToDef = Math.min(dmgRoll, d.force.health)
    d.force.health -= dmgToDef
    defName = forceNoun(d.force.type); ownerId = d.force.owner; unit = ' HP'
    if (d.force.health <= 0) s.forces = s.forces.filter((f) => f.id !== d.force.id)
  } else {
    dmgToDef = Math.min(dmgRoll, d.inst.integrity)
    d.inst.integrity = Math.max(0, d.inst.integrity - dmgToDef)
    defName = d.inst.type.replace('_', ' '); ownerId = d.inst.owner; unit = '% integrity'
    if (d.inst.integrity <= 0) s.installations = s.installations.filter((i) => i.id !== d.inst.id)
  }

  const atkDead = atk.health <= 0
  if (atkDead) s.forces = s.forces.filter((f) => f.id !== atk.id)
  const cleared = !atkDead && tileDefenders(s, to, mine).length === 0
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

  s.escalation = clamp(s.escalation + 6)
  s.factions[ownerId].disposition = clamp(s.factions[ownerId].disposition - 6, -100, 100)
  log(s, { kind: 'escalation', faction: atk.owner, text: `${s.factions[atk.owner].name}'s fleet engages ${s.factions[ownerId].name}'s ${defName} (−${dmgToDef}${unit}), taking −${dmgToAtk} HP ${outcome}.` })
  checkRegime(s)
  return s
}

export function moveForce(state: GameState, forceId: string, to: Hex): GameState {
  const s = clone(state)
  const force = s.forces.find((f) => f.id === forceId)
  if (!force) return state
  const deploying = isDeployTarget(s, force, to)
  const attacking = isArmyAttackTarget(s, force, to)
  const navalAssaulting = isNavalAssaultTarget(s, force, to)
  if (!deploying && !attacking && !navalAssaulting) return state

  if (navalAssaulting) return resolveNavalAssault(state, forceId, to)

  if (attacking && force.type === 'army_group') {
    const mine = s.factions[force.owner].alignment
    // Any defenders on the tile (enemy army, battery, or base) must be fought down
    // before you can advance — see resolveAssault.
    if (tileDefenders(s, to, mine).length) return resolveAssault(state, forceId, to)
    // Otherwise, hostile territory still has weak local defense (~strength 1) that
    // bloodies an advancing army — taking ground always costs something.
    const t = s.tiles[key(to)]
    force.acted = true
    if (t?.owner && t.owner !== force.owner) {
      const toll = clamp(Math.round((20 / force.strength) * (0.8 + Math.random() * 0.5)), 1, 100)
      const land = s.factions[t.owner].name
      force.health -= toll
      s.escalation = clamp(s.escalation + 4)
      s.factions[t.owner].disposition = clamp(s.factions[t.owner].disposition - 4, -100, 100)
      if (force.health <= 0) {
        s.forces = s.forces.filter((f) => f.id !== force.id)
        log(s, { kind: 'escalation', faction: force.owner, text: `${s.factions[force.owner].name}'s army is destroyed assaulting ${land} territory.` })
      } else {
        force.hex = to
        claimOccupiedHex(s, force)
        log(s, { kind: 'escalation', faction: force.owner, text: `${s.factions[force.owner].name}'s army pushes into ${land} territory against local resistance (−${toll} HP).` })
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
    const delta = force.type === 'naval_group' ? 1 : force.type === 'missile_battery' ? 3 : 2
    s.escalation = clamp(s.escalation + delta)
    const label = LABEL[force.type]
    log(s, { kind: 'escalation', faction: force.owner, text: `${s.factions[force.owner].name} forward-deploys ${label} toward the frontier. Tension rises.` })
  }
  return s
}

export const LABEL: Record<Force['type'], string> = {
  army_group: 'an army group',
  naval_group: 'a naval group',
  missile_battery: 'a missile battery',
}

const forceNoun = (t: Force['type']) => LABEL[t].replace(/^an? /, '')

// --- Claim territory (a political maneuver, not conquest) ------------------

/** Only army groups occupy/claim, on a plains tile that isn't yours — and only once
 *  any opposing army group defending the tile has been destroyed. */
export function canClaim(s: GameState, force: Force): boolean {
  if (force.acted) return false
  const t = s.tiles[key(force.hex)]
  if (!t || t.owner === force.owner) return false
  if (force.type === 'army_group' && t.terrain !== 'plains') return false
  if (force.type === 'naval_group' && t.terrain !== 'island') return false
  if (force.type === 'missile_battery') return false
  const mine = s.factions[force.owner].alignment
  const blockerType = force.type === 'naval_group' ? 'naval_group' : 'army_group'
  const defended = s.forces.some(
    (f) => f.id !== force.id && f.type === blockerType && hexEquals(f.hex, force.hex) && s.factions[f.owner].alignment !== mine,
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
  t.owner = force.owner
  t.dmz = false
  t.disputedBy = undefined
  t.contested = true
  s.escalation = clamp(s.escalation + (wasDmz ? 14 : 8))
  if (prevOwner) s.factions[prevOwner].disposition = clamp(s.factions[prevOwner].disposition - 10, -100, 100)
  force.acted = true
  log(s, {
    kind: 'escalation', faction: force.owner,
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
  const enemy = (id: string | null) => !!id && s.factions[id].alignment !== mine
  const keys = new Set<string>()
  for (const f of s.forces) if (enemy(f.owner) && distance(from, f.hex) <= range) keys.add(key(f.hex))
  for (const i of s.installations) if (enemy(i.owner) && distance(from, i.hex) <= range) keys.add(key(i.hex))
  return [...keys].map((k) => s.tiles[k].hex)
}

export function strikeTargets(s: GameState, force: Force): Hex[] {
  if (!canStrike(force)) return []
  return enemiesInRange(s, force.owner, force.hex, STRIKE_RANGE[kindOf(force)])
}

/** Hexes a specific air base can reach (empty if it has no sorties). */
export function airBaseTargets(s: GameState, baseId: string): Hex[] {
  const base = s.installations.find((i) => i.id === baseId)
  if (!base || base.type !== 'air_base' || (base.charges ?? 0) < 1) return []
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
  naval_group: 55,
  missile_battery: 28,
}

const NEW_FORCE_STRENGTH: Record<ForceType, number> = {
  army_group: 7,
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
  if (!f || f.procurement.policy === policy) return state
  f.procurement.policy = policy
  if (policy === 'draft') {
    f.support = clamp(f.support - 10)
    s.escalation = clamp(s.escalation + 4)
    log(s, { kind: 'escalation', faction: factionId, text: `${f.name} implements a draft. Manpower rises, but public support buckles.` })
  } else if (policy === 'emergency') {
    f.support = clamp(f.support - 2)
    s.escalation = clamp(s.escalation + 2)
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
  if (!f || f.procurement.burden === burden) return state
  f.procurement.burden = burden
  log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} sets procurement burden to ${burden}.` })
  return s
}

export function startProcurement(state: GameState, factionId: string, type: ProcurementProjectType): GameState {
  const s = clone(state)
  const f = s.factions[factionId]
  if (!f) return state
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
  if (!from || !to || from.alignment === 'neutral' || from.alignment !== to.alignment) return state

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
    s.escalation = clamp(s.escalation + 2)
    log(s, { kind: 'escalation', faction: fromId, text: `${from.name} ships arms to ${to.name}. Their build queue accelerates, and rivals notice.` })
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
  const supportRelief = s.escalation >= 60 ? 2 : s.escalation >= 35 ? 1 : 0
  const supportCost = Math.max(0, BURDEN_SUPPORT_COST[p.burden] + POLICY_SUPPORT_COST[p.policy] - supportRelief)
  const economyCost = BURDEN_ECONOMY_COST[p.burden]
  f.market = clamp(f.market - economyCost)
  f.support = clamp(f.support - supportCost)
  if (p.policy === 'emergency') s.escalation = clamp(s.escalation + 1)
  if (p.policy === 'draft') s.escalation = clamp(s.escalation + 2)
  log(s, { kind: 'dispatch', faction: factionId, text: `${f.name} adds ${rate} procurement to ${PROJECT_LABEL[p.project.type]} (${Math.min(p.project.progress, PROJECT_COST[p.project.type])}/${PROJECT_COST[p.project.type]}).` })
  completeProcurementIfReady(s, factionId)
  checkRegime(s)
}

// --- Trade network -------------------------------------------------------

export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('|')
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

/** Cut or restore the (a,b) trade link. Both economies recompute; the hit to each
 *  is proportional to the *other's* size. A nation only controls its own links —
 *  a bloc-wide embargo requires convincing every nation independently. */
export function toggleEmbargo(state: GameState, a: string, b: string): GameState {
  if (a === b) return state
  const s = clone(state)
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
    s.escalation = clamp(s.escalation + 3)
    s.factions[b].disposition = clamp(s.factions[b].disposition - 6, -100, 100)
    log(s, { kind: 'dispatch', faction: a, text: `${A} embargoes ${B}. ${B}'s economy falls to ${s.factions[b].market}; ${A}'s to ${s.factions[a].market}.` })
  } else {
    s.escalation = clamp(s.escalation - 1)
    s.factions[b].disposition = clamp(s.factions[b].disposition + 4, -100, 100)
    log(s, { kind: 'dispatch', faction: a, text: `${A} restores trade with ${B}.` })
  }
  checkRegime(s)
  return s
}

function checkRegime(s: GameState) {
  if (s.regimeFallen) return
  for (const f of Object.values(s.factions)) {
    if (f.support <= 0) {
      s.regimeFallen = f.id
      log(s, { kind: 'system', text: `${f.name}'s government collapses — domestic support has hit zero. Regime change.` })
      return
    }
  }
}

/** Apply a strike to the target hex. A friendly garrison base shields any forces
 *  on the tile (the base soaks the hit until destroyed). Caller spends charges. */
function applyStrike(s: GameState, atkId: string, target: Hex, kind: StrikeKind, intensity: StrikeIntensity) {
  const tkey = key(target)
  const mine = s.factions[atkId].alignment
  const me = s.factions[atkId].name
  const verb = `${me} lands a ${intensity} ${KIND_LABEL[kind]}`
  const enemyInst = (pred: (i: Installation) => boolean) =>
    s.installations.find((i) => key(i.hex) === tkey && s.factions[i.owner].alignment !== mine && pred(i))
  const enemyForce = s.forces.find((f) => key(f.hex) === tkey && s.factions[f.owner].alignment !== mine)
  const shield = enemyInst((i) => PROTECTING.includes(i.type))

  // Priority: a protecting base shields forces; else a force; else a soft installation.
  const inst = shield ?? (enemyForce ? undefined : enemyInst(() => true))

  if (inst) {
    const owner = s.factions[inst.owner]
    inst.integrity = Math.max(0, inst.integrity - rollStruct(kind, intensity))
    if (inst.type === 'city') {
      recomputeMarket(s, inst.owner)
      owner.support = clamp(owner.support + (intensity === 'full' ? 12 : 8)) // rally-round-the-flag
      owner.disposition = clamp(owner.disposition - 12, -100, 100)
      s.escalation = clamp(s.escalation + (intensity === 'full' ? 16 : 10))
      log(s, { kind: 'escalation', faction: atkId, text: `${verb} on a ${owner.name} city (integrity ${inst.integrity}%). Outrage rallies its people behind their government; the economy reels.` })
    } else {
      s.escalation = clamp(s.escalation + (intensity === 'full' ? 8 : 5))
      owner.disposition = clamp(owner.disposition - 8, -100, 100)
      const garrisoned = shield === inst && !!enemyForce
      if (inst.integrity <= 0) {
        s.installations = s.installations.filter((i) => i.id !== inst.id)
        log(s, { kind: 'escalation', faction: atkId, text: `${verb} on ${owner.name}'s ${inst.type.replace('_', ' ')} — destroyed.` })
      } else {
        log(s, { kind: 'escalation', faction: atkId, text: `${verb} on ${owner.name}'s ${inst.type.replace('_', ' ')} (integrity ${inst.integrity}%${garrisoned ? ', shielding its garrison' : ''}).` })
      }
    }
    return
  }

  if (enemyForce) {
    // Civ-style combat roll. Effectiveness vs ARMY: air devastating, missile/naval weak.
    const factor = enemyForce.type === 'army_group' ? (kind === 'air' ? 1.6 : 0.5) : 1
    enemyForce.health -= Math.round(rollCombat(kind, intensity) * factor)
    const on = s.factions[enemyForce.owner].name
    if (enemyForce.health <= 0) {
      s.forces = s.forces.filter((f) => f.id !== enemyForce.id)
      log(s, { kind: 'escalation', faction: atkId, text: `${verb} on ${on}'s ${forceNoun(enemyForce.type)} — destroyed.` })
    } else {
      log(s, { kind: 'escalation', faction: atkId, text: `${verb} on ${on}'s ${forceNoun(enemyForce.type)} (now ${enemyForce.health} HP).` })
    }
    s.escalation = clamp(s.escalation + (intensity === 'full' ? 7 : 4))
    s.factions[enemyForce.owner].disposition = clamp(s.factions[enemyForce.owner].disposition - 6, -100, 100)
  }
}

export function forceStrike(state: GameState, forceId: string, target: Hex, intensity: StrikeIntensity): GameState {
  const s = clone(state)
  const force = s.forces.find((f) => f.id === forceId)
  if (!force || !canStrike(force) || (force.charges ?? 0) < chargeCost(intensity)) return state
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
  if (!base || base.type !== 'air_base') return state
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
    // Slow ambient de-escalation between rounds if nobody is pushing hard.
    if (s.escalation > 0 && s.escalation < 85) s.escalation = clamp(s.escalation - 1)
    log(s, { kind: 'system', text: `Round ${s.turn} begins.` })
  }
  const next = s.factions[currentFactionId(s)]
  restock(s, next.id) // resupply the incoming faction's strike platforms
  processProcurement(s, next.id)
  log(s, { kind: 'system', faction: next.id, text: `${next.name}'s turn.` })
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
  | { type: 'end_turn' }

/** Every action the current faction can legally take right now.
 *  Returns a flat, serializable list suitable for LLM tool-call enumeration. */
export function availableActions(state: GameState): Action[] {
  if (state.regimeFallen) return []
  const factionId = currentFactionId(state)
  const faction = state.factions[factionId]
  const actions: Action[] = []

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
    const embargoed = isEmbargoed(state, factionId, other.id)
    if (!embargoed || embargoOwner(state, factionId, other.id) === factionId)
      actions.push({ type: 'toggle_trade', targetId: other.id })
  }

  actions.push({ type: 'end_turn' })
  return actions
}

/** Execute a single action for the current faction. Returns a new GameState.
 *  Returns the same state reference (no-op) if the action is invalid. */
export function dispatch(state: GameState, action: Action): GameState {
  if (state.regimeFallen && action.type !== 'end_turn') return state
  const factionId = currentFactionId(state)
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
    case 'end_turn':               return endFactionTurn(state)
    default:                       return state
  }
}
