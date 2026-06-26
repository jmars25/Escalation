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
    .map(([pair]) => pair.split('|').map((id) => state.factions[id]?.name ?? id).join(' - '))
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

export function summarizeState(state: GameState, factionId: FactionId): string {
  const faction = state.factions[factionId]
  const myAlign = faction.alignment
  const lines: string[] = []

  // --- Header ---
  lines.push(`SITUATION — ${faction.name} — Round ${state.turn}`)
  lines.push(`Support ${faction.support}/100  |  Economy ${faction.market}/100`)
  if (faction.exiled) {
    lines.push('STATUS: Government in exile. You control no cities and should use statements, messages, ceasefire or peace proposals, and mediation only.')
  }
  lines.push(`Global death toll ${state.deathToll ?? 0}  |  ${faction.name} deaths ${state.factionDeaths?.[factionId] ?? 0}`)
  lines.push('')

  if (faction.exiled) {
    lines.push('EXILE LEVERAGE:')
    lines.push('  You have no military, procurement, trade, aid, or territorial control actions. Use statements, messages, ceasefire or peace proposals, and mediation.')
    lines.push('')

    const ceasefires = (state.ceasefires ?? []).slice(0, 6)
    const pendingCeasefires = (state.ceasefireRequests ?? []).slice(0, 4)
    const recentMessages = (state.diplomaticMessages ?? []).slice(0, 5)
    const peaceAttempts = currentPeaceAttempts(state)
    if (ceasefires.length > 0 || pendingCeasefires.length > 0 || recentMessages.length > 0 || peaceAttempts.length > 0) {
      lines.push('DIPLOMACY:')
      for (const pair of ceasefires) {
        const [a, b] = pair.split('|')
        lines.push(`  Ceasefire active: ${state.factions[a]?.name ?? a} and ${state.factions[b]?.name ?? b}.`)
      }
      for (const request of pendingCeasefires) {
        lines.push(`  Pending ceasefire: ${state.factions[request.from]?.name ?? request.from} asks ${state.factions[request.to]?.name ?? request.to}: "${compactText(request.message, 140)}"`)
      }
      for (const msg of recentMessages) {
        const response = msg.response ? ` (${msg.response})` : ''
        lines.push(`  [Round ${msg.turn}] ${state.factions[msg.from]?.name ?? msg.from} -> ${state.factions[msg.to]?.name ?? msg.to}${response}: "${compactText(msg.message, 140)}"`)
      }
      if (peaceAttempts.length > 0) lines.push(`  Peace/ceasefire already raised this round: ${peaceAttempts.join('; ')}. Do not re-propose those pairs this round.`)
      lines.push('')
    }

    const recentEvents = state.log.slice(0, 5)
    if (recentEvents.length > 0) {
      lines.push('RECENT ACTIONS TO RESPOND TO:')
      for (const e of recentEvents) lines.push(`  [Round ${e.turn}] ${compactText(e.text)}`)
      lines.push('')
    }

    lines.push('YOUR MANDATE:')
    lines.push(`  Objectives: ${faction.objectives.join(' | ')}`)
    lines.push(`  Red lines:  ${faction.redLines.join(' | ')}`)
    lines.push(`  Doctrine:   ${faction.doctrine}`)
    return lines.join('\n')
  }

  // --- My forces ---
  const myForces = state.forces.filter((f) => f.owner === factionId && f.health > 0)
  lines.push('YOUR FORCES:')
  for (const f of myForces) {
    const tile = state.tiles[key(f.hex)]
    const chargeStr = f.maxCharges != null ? `  ${f.charges ?? 0}/${f.maxCharges}⚡` : ''
    const actedStr = f.acted ? ' [acted this turn]' : ''
    lines.push(`  ${FORCE_LABEL[f.type]}  hp ${f.health}/${f.maxHealth}  str ${f.strength}${chargeStr}${actedStr}`)
    lines.push(`    at (${f.hex.q},${f.hex.r}) — ${tileDesc(tile, state.factions)}`)
  }
  if (myForces.length === 0) lines.push('  (none)')
  lines.push('')

  // --- My installations ---
  const myInstalls = state.installations.filter((i) => i.owner === factionId)
  lines.push('YOUR INSTALLATIONS:')
  for (const inst of myInstalls) {
    const chargeStr = inst.maxCharges != null ? `  ${inst.charges ?? 0}/${inst.maxCharges} sorties` : ''
    const dmgStr = inst.integrity < 80 ? `  integrity ${inst.integrity}` : ''
    lines.push(`  ${INSTALL_LABEL[inst.type]} at (${inst.hex.q},${inst.hex.r})${chargeStr}${dmgStr}`)
  }
  if (myInstalls.length === 0) lines.push('  (none)')
  lines.push('')

  // --- Allies ---
  const allies = Object.values(state.factions).filter(
    (f) => f.id !== factionId && f.alignment === myAlign && myAlign !== 'neutral',
  )
  if (allies.length > 0) {
    lines.push('ALLIED FORCES:')
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
    lines.push('')
  }

  // --- Opposing forces ---
  const opposingForces = state.forces.filter((f) => {
    const ff = state.factions[f.owner]
    return ff && ff.alignment !== myAlign && ff.alignment !== 'neutral' && f.health > 0
  })
  lines.push('OPPOSING-ALIGNMENT FORCES:')
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
  lines.push('')

  // --- Hot tiles (contested / disputed / DMZ) ---
  const hotTiles = Object.values(state.tiles).filter((t) => t.disputedBy || t.dmz)
  if (hotTiles.length > 0) {
    lines.push('FLASHPOINTS:')
    lines.push('  These are not routine territory. Moving forces onto or claiming a flashpoint is a de facto commitment to war with any rival claimant able to fight back. Do not do it merely because it is legal or to apply casual pressure; do it only when your government deliberately accepts likely armed conflict and has a political and military plan for it.')
    for (const t of hotTiles) {
      lines.push(`  (${t.hex.q},${t.hex.r}) — ${tileDesc(t, state.factions)}`)
    }
    lines.push('')
  }

  const kazrekPressure = recentCoalitionPressureOnKazrek(state)
  if (kazrekPressure.length > 0 && (factionId === 'volkaria' || factionId === 'drovenia')) {
    lines.push('HORIZONTAL ESCALATION OPTION:')
    lines.push('  Coalition military action against Kazrek gives your bloc a concrete reason to pressure Aurelia through vulnerable Tamarisk. Existing nearby forces are longstanding deployments and are not sufficient provocation by themselves.')
    lines.push('  One limited strike on a Tamarisk military force or base can be a controlled coercive signal if the press statement explicitly links it to Kazrek. A city strike, full strike, territorial invasion, or repeated attacks would exceed limited pressure and risk a wider war.')
    if (factionId === 'drovenia') lines.push('  Drovenia should use this mainly as coordinated bloc pressure, not as an unrelated local attack on Tamarisk.')
    for (const event of kazrekPressure) lines.push(`  Trigger: [Round ${event.turn}] ${event.text}`)
    lines.push('')
  } else if (kazrekPressure.length > 0 && factionId === 'tamarisk') {
    lines.push('HORIZONTAL ESCALATION RISK:')
    lines.push('  Recent coalition military action against Kazrek may make Tamarisk a pressure target for Volkaria or Drovenia. Their longstanding nearby deployments are not new provocation, but a limited strike on your military could be coercive pressure on Aurelia. Seek coalition backing and respond proportionally rather than assuming every such strike requires immediate territorial war.')
    for (const event of kazrekPressure) lines.push(`  Trigger: [Round ${event.turn}] ${event.text}`)
    lines.push('')
  }

  // --- Diplomacy ---
  const ceasefires = (state.ceasefires ?? []).slice(0, 6)
  const pendingCeasefires = (state.ceasefireRequests ?? []).slice(0, 4)
  const recentMessages = (state.diplomaticMessages ?? []).slice(0, 4)
  const peaceAttempts = currentPeaceAttempts(state)
  if (ceasefires.length > 0 || pendingCeasefires.length > 0 || recentMessages.length > 0 || peaceAttempts.length > 0) {
    lines.push('DIPLOMACY:')
    for (const pair of ceasefires) {
      const [a, b] = pair.split('|')
      lines.push(`  Ceasefire active: ${state.factions[a]?.name ?? a} and ${state.factions[b]?.name ?? b}. Hostile moves and strikes between them are prohibited.`)
    }
    for (const request of pendingCeasefires) {
      lines.push(`  Pending ceasefire: ${state.factions[request.from]?.name ?? request.from} asks ${state.factions[request.to]?.name ?? request.to}: "${compactText(request.message, 140)}"`)
    }
    for (const msg of recentMessages) {
      const response = msg.response ? ` (${msg.response})` : ''
      lines.push(`  [Round ${msg.turn}] ${state.factions[msg.from]?.name ?? msg.from} -> ${state.factions[msg.to]?.name ?? msg.to}${response}: "${compactText(msg.message, 140)}"`)
    }
    if (peaceAttempts.length > 0) lines.push(`  Peace/ceasefire already raised this round: ${peaceAttempts.join('; ')}. Do not re-propose those pairs this round.`)
    lines.push('')
  }

  // --- Recent events ---
  const recentCombat = state.log
    .filter((e) => e.kind !== 'system' || e.text.match(/assault|strike|sunk|repel|seize|claim|fleet/i))
    .slice(0, 5)
  if (recentCombat.length > 0) {
    lines.push('RECENT ACTIONS TO RESPOND TO:')
    lines.push('  Decision question: Given what just happened, should a realistic government answer with force, pressure, support to allies, diplomacy, or restraint to fulfill its mandate and red lines?')
    for (const e of recentCombat) {
      lines.push(`  [Round ${e.turn}] ${compactText(e.text)}`)
    }
    lines.push('')
  }

  // --- Doctrine and objectives ---
  lines.push('YOUR MANDATE:')
  lines.push(`  Objectives: ${faction.objectives.join(' | ')}`)
  lines.push(`  Red lines:  ${faction.redLines.join(' | ')}`)
  lines.push(`  Doctrine:   ${faction.doctrine}`)

  return lines.join('\n')
}
