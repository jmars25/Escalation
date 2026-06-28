import type { FactionId, GameState, Tile } from '../src/game/types.ts'
import { key, neighbors } from '../src/game/hexUtils.ts'

const FORCE_LABEL: Record<string, string> = {
  army_group: 'Army Group',
  marine: 'Marines',
  naval_group: 'Naval Group',
  missile_battery: 'Missile Battery',
}

const INSTALL_LABEL: Record<string, string> = {
  city: 'City',
  army_base: 'Army Base',
  air_base: 'Air Base',
  naval_base: 'Naval Base',
  radar: 'Radar',
}

/** A summary section: its lines, or an empty array when the section should be omitted. */
type Block = string[]

function factionName(state: GameState, id: string): string {
  return state.factions[id]?.name ?? id
}

function tileDesc(tile: Tile | undefined, factions: GameState['factions']): string {
  if (!tile) return 'unknown'
  const parts: string[] = []
  if (tile.owner) parts.push(factions[tile.owner]?.name ?? tile.owner)
  if (tile.terrain !== 'plains') parts.push(tile.terrain)
  if (tile.strait) parts.push('(strait)')
  if (tile.dmz) parts.push('[DMZ]')
  if (tile.contested) parts.push('[front line]')
  if (tile.disputedBy) parts.push(`[disputed: ${tile.disputedBy.map((id) => factions[id]?.name ?? id).join(' vs ')}]`)
  return parts.join(' ') || 'unclaimed'
}

function compactText(text: string, max = 180): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 3)}...`
}

function currentPeaceAttempts(state: GameState): string[] {
  return Object.entries(state.peacePairAttemptTurn ?? {})
    .filter(([, turn]) => turn >= state.turn)
    .map(([pair]) => pair.split('|').map((id) => factionName(state, id)).join(' - '))
}

export function recentCoalitionPressureOnKazrek(state: GameState): GameState['log'] {
  const earliestTurn = Math.max(1, state.turn - 1)
  return state.log
    .filter((event) =>
      event.turn >= earliestTurn &&
      event.kind === 'system' &&
      !!event.faction &&
      state.factions[event.faction]?.alignment === 'coalition' &&
      /kazrek/i.test(event.text) &&
      /assault|strike|pushes into|seize|claim|destroy/i.test(event.text),
    )
    .slice(0, 4)
}

/** Joins blocks together, dropping empty ones and separating the rest with a blank line. */
function assemble(blocks: Block[]): string {
  return blocks
    .filter((block) => block.length > 0)
    .map((block) => block.join('\n'))
    .join('\n\n')
}

function headerBlock(state: GameState, factionId: FactionId): Block {
  const faction = state.factions[factionId]
  const lines = [
    `SITUATION — ${faction.name} — Round ${state.turn}`,
    `Support ${faction.support}/100  |  Economy ${faction.market}/100`,
  ]
  if (faction.exiled) {
    lines.push('STATUS: Government in exile. You control no cities and should use statements, messages, ceasefire or peace proposals, and mediation only.')
  }
  lines.push(`Global death toll ${state.deathToll ?? 0}  |  ${faction.name} deaths ${state.factionDeaths?.[factionId] ?? 0}`)
  return lines
}

function mandateBlock(faction: GameState['factions'][string]): Block {
  return [
    'YOUR MANDATE:',
    `  Objectives: ${faction.objectives.join(' | ')}`,
    `  Red lines:  ${faction.redLines.join(' | ')}`,
    `  Doctrine:   ${faction.doctrine}`,
  ]
}

/**
 * Ceasefires, pending requests, recent messages, and peace attempts.
 * `ceasefireSuffix` and `messageLimit` differ between the exile and normal views.
 */
function diplomacyBlock(
  state: GameState,
  { messageLimit, ceasefireSuffix }: { messageLimit: number; ceasefireSuffix: string },
): Block {
  const ceasefires = (state.ceasefires ?? []).slice(0, 6)
  const pendingCeasefires = (state.ceasefireRequests ?? []).slice(0, 4)
  const recentMessages = (state.diplomaticMessages ?? []).slice(0, messageLimit)
  const peaceAttempts = currentPeaceAttempts(state)
  if (!ceasefires.length && !pendingCeasefires.length && !recentMessages.length && !peaceAttempts.length) {
    return []
  }

  const lines = ['DIPLOMACY:']
  for (const pair of ceasefires) {
    const [a, b] = pair.split('|')
    lines.push(`  Ceasefire active: ${factionName(state, a)} and ${factionName(state, b)}.${ceasefireSuffix}`)
  }
  for (const request of pendingCeasefires) {
    lines.push(`  Pending ceasefire: ${factionName(state, request.from)} asks ${factionName(state, request.to)}: "${compactText(request.message, 140)}"`)
  }
  for (const msg of recentMessages) {
    const response = msg.response ? ` (${msg.response})` : ''
    lines.push(`  [Round ${msg.turn}] ${factionName(state, msg.from)} -> ${factionName(state, msg.to)}${response}: "${compactText(msg.message, 140)}"`)
  }
  if (peaceAttempts.length > 0) {
    lines.push(`  Peace/ceasefire already raised this round: ${peaceAttempts.join('; ')}. Do not re-propose those pairs this round.`)
  }
  return lines
}

function recentActionsBlock(events: GameState['log'], decisionPrompt?: string): Block {
  if (events.length === 0) return []
  const lines = ['RECENT ACTIONS TO RESPOND TO:']
  if (decisionPrompt) lines.push(decisionPrompt)
  for (const e of events) lines.push(`  [Round ${e.turn}] ${compactText(e.text)}`)
  return lines
}

function exileLeverageBlock(): Block {
  return [
    'EXILE LEVERAGE:',
    '  You have no military, procurement, trade, aid, or territorial control actions. Use statements, messages, ceasefire or peace proposals, and mediation.',
  ]
}

function myForcesBlock(state: GameState, myForces: GameState['forces']): Block {
  const lines = ['YOUR FORCES:']
  for (const f of myForces) {
    const tile = state.tiles[key(f.hex)]
    const chargeStr = f.maxCharges != null ? `  ${f.charges ?? 0}/${f.maxCharges}⚡` : ''
    const actedStr = f.acted ? ' [acted this turn]' : ''
    lines.push(`  ${FORCE_LABEL[f.type]}  hp ${f.health}/${f.maxHealth}  str ${f.strength}${chargeStr}${actedStr}`)
    lines.push(`    at (${f.hex.q},${f.hex.r}) — ${tileDesc(tile, state.factions)}`)
  }
  if (myForces.length === 0) lines.push('  (none)')
  return lines
}

function myInstallationsBlock(state: GameState, factionId: FactionId): Block {
  const myInstalls = state.installations.filter((i) => i.owner === factionId)
  const lines = ['YOUR INSTALLATIONS:']
  for (const inst of myInstalls) {
    const chargeStr = inst.maxCharges != null ? `  ${inst.charges ?? 0}/${inst.maxCharges} sorties` : ''
    const dmgStr = inst.integrity < 80 ? `  integrity ${inst.integrity}` : ''
    lines.push(`  ${INSTALL_LABEL[inst.type]} at (${inst.hex.q},${inst.hex.r})${chargeStr}${dmgStr}`)
  }
  if (myInstalls.length === 0) lines.push('  (none)')
  return lines
}

function alliesBlock(state: GameState, factionId: FactionId, myAlign: string): Block {
  const allies = Object.values(state.factions).filter(
    (f) => f.id !== factionId && f.alignment === myAlign && myAlign !== 'neutral',
  )
  if (allies.length === 0) return []

  const lines = ['ALLIED FORCES:']
  for (const ally of allies) {
    const allyForces = state.forces.filter((f) => f.owner === ally.id && f.health > 0)
    if (allyForces.length === 0) {
      lines.push(`  [${ally.name}] no forces`)
      continue
    }
    for (const f of allyForces) {
      const tile = state.tiles[key(f.hex)]
      lines.push(`  [${ally.name}] ${FORCE_LABEL[f.type]}  hp ${f.health}/${f.maxHealth}  at (${f.hex.q},${f.hex.r}) — ${tileDesc(tile, state.factions)}`)
    }
  }
  return lines
}

function opposingForcesBlock(state: GameState, myAlign: string, myForces: GameState['forces']): Block {
  const opposingForces = state.forces.filter((f) => {
    const ff = state.factions[f.owner]
    return ff && ff.alignment !== myAlign && ff.alignment !== 'neutral' && f.health > 0
  })

  const lines = ['OPPOSING-ALIGNMENT FORCES:']
  for (const f of opposingForces) {
    const tile = state.tiles[key(f.hex)]
    const chargeStr = f.maxCharges != null ? `  ${f.charges ?? 0}/${f.maxCharges}⚡` : ''
    // Nearby opposing forces are relevant, but proximity alone is not an attack.
    const adjacent = myForces.filter((mf) =>
      neighbors(mf.hex).some((n) => n.q === f.hex.q && n.r === f.hex.r),
    )
    const threatStr = adjacent.length > 0
      ? `  near your ${adjacent.map((mf) => FORCE_LABEL[mf.type]).join(', ')} (proximity alone is not hostile action)`
      : ''
    lines.push(`  [${state.factions[f.owner]?.name}] ${FORCE_LABEL[f.type]}  hp ${f.health}/${f.maxHealth}${chargeStr}${threatStr}`)
    lines.push(`    at (${f.hex.q},${f.hex.r}) — ${tileDesc(tile, state.factions)}`)
  }
  if (opposingForces.length === 0) lines.push('  (none visible)')
  return lines
}

function flashpointsBlock(state: GameState): Block {
  const hotTiles = Object.values(state.tiles).filter((t) => t.disputedBy || t.dmz)
  if (hotTiles.length === 0) return []

  const lines = [
    'FLASHPOINTS:',
    '  These are not routine territory. Moving forces onto or claiming a flashpoint is a de facto commitment to war with any rival claimant able to fight back. Do not do it merely because it is legal or to apply casual pressure; do it only when your government deliberately accepts likely armed conflict and has a political and military plan for it.',
  ]
  for (const t of hotTiles) {
    lines.push(`  (${t.hex.q},${t.hex.r}) — ${tileDesc(t, state.factions)}`)
  }
  return lines
}

function escalationBlock(state: GameState, factionId: FactionId): Block {
  const kazrekPressure = recentCoalitionPressureOnKazrek(state)
  if (kazrekPressure.length === 0) return []

  const triggers = kazrekPressure.map((event) => `  Trigger: [Round ${event.turn}] ${event.text}`)

  if (factionId === 'volkaria' || factionId === 'drovenia') {
    const lines = [
      'HORIZONTAL ESCALATION OPTION:',
      '  Coalition military action against Kazrek gives your bloc a concrete reason to pressure Aurelia through vulnerable Tamarisk. Existing nearby forces are longstanding deployments and are not sufficient provocation by themselves.',
      '  One limited strike on a Tamarisk military force or base can be a controlled coercive signal if the press statement explicitly links it to Kazrek. A city strike, full strike, territorial invasion, or repeated attacks would exceed limited pressure and risk a wider war.',
      ' Your population expects your goverment to aid any creed follower. Ignoring Kazrek deaths will look bad for your regime.',
    ]
    if (factionId === 'drovenia') {
      lines.push('  Drovenia should use this mainly as coordinated bloc pressure, not as an unrelated local attack on Tamarisk.')
    }
    return [...lines, ...triggers]
  }

  if (factionId === 'tamarisk') {
    return [
      'HORIZONTAL ESCALATION RISK:',
      '  Recent coalition military action against Kazrek may make Tamarisk a pressure target for Volkaria or Drovenia. Their longstanding nearby deployments are not new provocation, but a limited strike on your military could be coercive pressure on Aurelia. Seek coalition backing and respond proportionally rather than assuming every such strike requires immediate territorial war.',
      ...triggers,
    ]
  }

  return []
}

function exileSummary(state: GameState, factionId: FactionId): string {
  const faction = state.factions[factionId]
  return assemble([
    headerBlock(state, factionId),
    exileLeverageBlock(),
    diplomacyBlock(state, { messageLimit: 5, ceasefireSuffix: '' }),
    recentActionsBlock(state.log.slice(0, 5)),
    mandateBlock(faction),
  ])
}

function activeSummary(state: GameState, factionId: FactionId): string {
  const faction = state.factions[factionId]
  const myAlign = faction.alignment
  const myForces = state.forces.filter((f) => f.owner === factionId && f.health > 0)
  const recentCombat = state.log
    .filter((e) => e.kind !== 'system' || e.text.match(/assault|strike|sunk|repel|seize|claim|fleet/i))
    .slice(0, 5)

  return assemble([
    headerBlock(state, factionId),
    myForcesBlock(state, myForces),
    myInstallationsBlock(state, factionId),
    alliesBlock(state, factionId, myAlign),
    opposingForcesBlock(state, myAlign, myForces),
    flashpointsBlock(state),
    escalationBlock(state, factionId),
    diplomacyBlock(state, {
      messageLimit: 4,
      ceasefireSuffix: ' Hostile moves and strikes between them are prohibited.',
    }),
    recentActionsBlock(
      recentCombat,
      '  Decision question: Given what just happened, should a realistic government answer with force, pressure, support to allies, diplomacy, or restraint to fulfill its mandate and red lines?',
    ),
    mandateBlock(faction),
  ])
}

export function summarizeState(state: GameState, factionId: FactionId): string {
  return state.factions[factionId].exiled
    ? exileSummary(state, factionId)
    : activeSummary(state, factionId)
}
