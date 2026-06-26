import { availableActions, isEmbargoed, toggleEmbargo } from '../../src/game/engine.ts'
import type { Action } from '../../src/game/engine.ts'
import type { FactionId, Force, GameState, Hex, Installation, Tile } from '../../src/game/types.ts'
import { key } from '../../src/game/hexUtils.ts'
import { recentCoalitionPressureOnKazrek, summarizeState } from '../summarize.ts'
import type { AgentTool } from './types.ts'

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

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: 'move_force',
    description: 'Move/deploy a force. Foreign land entry is war.',
    input_schema: {
      type: 'object',
      properties: {
        forceId: { type: 'string', description: 'Force id' },
        to: {
          type: 'object',
          description: 'Hex',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
      },
      required: ['forceId', 'to'],
    },
  },
  {
    name: 'claim_hex',
    description: 'Claim current hex. Major diplomatic harm.',
    input_schema: {
      type: 'object',
      properties: {
        forceId: { type: 'string', description: 'Force id' },
      },
      required: ['forceId'],
    },
  },
  {
    name: 'force_strike',
    description: 'Missile/naval strike.',
    input_schema: {
      type: 'object',
      properties: {
        forceId: { type: 'string', description: 'Force id' },
        target: {
          type: 'object',
          description: 'Hex',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
        intensity: { type: 'string', enum: ['limited', 'full'], description: 'limited=1 charge, full=2' },
      },
      required: ['forceId', 'target', 'intensity'],
    },
  },
  {
    name: 'air_strike',
    description: 'Air strike from base.',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string', description: 'Air base id' },
        target: {
          type: 'object',
          description: 'Hex',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
        intensity: { type: 'string', enum: ['limited', 'full'] },
      },
      required: ['baseId', 'target', 'intensity'],
    },
  },
  {
    name: 'toggle_trade',
    description: 'Embargo/restore trade. Pressure short of war.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'Faction id',
        },
      },
      required: ['targetId'],
    },
  },
  {
    name: 'set_procurement_policy',
    description: 'Set procurement policy.',
    input_schema: {
      type: 'object',
      properties: {
        policy: { type: 'string', enum: ['civilian', 'contracts', 'emergency', 'draft'] },
      },
      required: ['policy'],
    },
  },
  {
    name: 'set_procurement_burden',
    description: 'Set build burden. Higher is faster but costly.',
    input_schema: {
      type: 'object',
      properties: {
        burden: { type: 'string', enum: ['low', 'standard', 'high', 'crisis'] },
      },
      required: ['burden'],
    },
  },
  {
    name: 'start_procurement',
    description: 'Start/switch procurement project.',
    input_schema: {
      type: 'object',
      properties: {
        projectType: { type: 'string', enum: ['army_group', 'missile_battery', 'naval_group', 'air_base', 'naval_base'] },
      },
      required: ['projectType'],
    },
  },
  {
    name: 'send_aid',
    description: 'Send economic/arms aid to ally.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Ally id' },
        aidType: { type: 'string', enum: ['economic', 'arms'] },
      },
      required: ['targetId', 'aidType'],
    },
  },
  {
    name: 'send_message',
    description: 'Send diplomatic note, max 3 sentences.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Faction id' },
        message: { type: 'string', description: 'Message', maxLength: 420 },
      },
      required: ['targetId', 'message'],
    },
  },
  {
    name: 'propose_ceasefire',
    description: 'Ask for bilateral ceasefire.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Faction id' },
        message: { type: 'string', description: 'Proposal', maxLength: 420 },
      },
      required: ['targetId', 'message'],
    },
  },
  {
    name: 'propose_peace',
    description: 'Offer peace; optional returned land.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Faction id' },
        message: { type: 'string', description: 'Offer', maxLength: 420 },
        returnHexes: {
          type: 'array',
          description: 'Hexes to return',
          items: {
            type: 'object',
            properties: { q: { type: 'number' }, r: { type: 'number' } },
            required: ['q', 'r'],
          },
        },
      },
      required: ['targetId', 'message'],
    },
  },
  {
    name: 'mediate_peace',
    description: 'Mediate peace between two sides.',
    input_schema: {
      type: 'object',
      properties: {
        sideAId: { type: 'string', description: 'Faction id' },
        sideBId: { type: 'string', description: 'Faction id' },
        message: { type: 'string', description: 'Proposal', maxLength: 420 },
        returnHexes: {
          type: 'array',
          description: 'Hexes sideB returns',
          items: {
            type: 'object',
            properties: { q: { type: 'number' }, r: { type: 'number' } },
            required: ['q', 'r'],
          },
        },
      },
      required: ['sideAId', 'sideBId', 'message'],
    },
  },
  {
    name: 'return_land',
    description: 'Return captured land.',
    input_schema: {
      type: 'object',
      properties: {
        hex: {
          type: 'object',
          description: 'Hex',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
        toId: { type: 'string', description: 'Faction id' },
      },
      required: ['hex', 'toId'],
    },
  },
  {
    name: 'respond_ceasefire',
    description: 'Accept/reject pending ceasefire first.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id' },
        response: { type: 'string', enum: ['accepted', 'rejected'] },
        message: { type: 'string', description: 'Explanation', maxLength: 420 },
      },
      required: ['requestId', 'response', 'message'],
    },
  },
  {
    name: 'end_turn',
    description: 'Finish turn with public statement.',
    input_schema: {
      type: 'object',
      properties: {
        pressStatement: {
          type: 'string',
          description: 'Max 3 sentences',
          maxLength: 420,
        },
      },
      required: ['pressStatement'],
    },
  },
]

export function buildSystemPrompt(state: GameState, factionId: FactionId): string {
  const faction = state.factions[factionId]
  const summary = summarizeState(state, factionId)
  const available = availableActions(state)

  // Condense the action list so the model sees legal choices without a giant JSON blob.
  const movesByForce: Record<string, Record<string, string[]>> = {}
  const claimActions: string[] = []
  const strikesByForce = new Map<string, { label: string; intensities: Set<string> }>()
  const airStrikes = new Map<string, { label: string; intensities: Set<string> }>()
  const tradeActions: string[] = []
  const procurementActions: string[] = []
  const aidActions: string[] = []
  const messageTargets: string[] = []
  const ceasefireTargets: string[] = []
  const peaceTargets: string[] = []
  const mediationTargets = new Set<string>()
  const responseActions: string[] = []
  const returnLandActions: string[] = []
  const other: string[] = []

  for (const action of available) {
    if (action.type === 'move_force') {
      const context = moveDestinationGroupLabel(state, factionId, action)
      ;((movesByForce[action.forceId] ??= {})[context] ??= []).push(hexLabel(action.to))
    } else if (action.type === 'claim_hex') {
      claimActions.push(claimActionLabel(state, factionId, action.forceId))
    } else if (action.type === 'force_strike') {
      const label = `${actorLabel(state, action.forceId)}>${hexLabel(action.target)} ${actionContext(state, factionId, action)}`
      ;(strikesByForce.get(label) ?? strikesByForce.set(label, { label, intensities: new Set() }).get(label)!).intensities.add(action.intensity)
    } else if (action.type === 'air_strike') {
      const label = `${installationLabel(state, action.baseId)}>${hexLabel(action.target)} ${actionContext(state, factionId, action)}`
      ;(airStrikes.get(label) ?? airStrikes.set(label, { label, intensities: new Set() }).get(label)!).intensities.add(action.intensity)
    } else if (action.type === 'toggle_trade') {
      tradeActions.push(tradeActionLabel(state, factionId, action.targetId))
    } else if (action.type === 'set_procurement_policy' || action.type === 'set_procurement_burden' || action.type === 'start_procurement') {
      procurementActions.push(otherActionLabel(state, action))
    } else if (action.type === 'send_aid') {
      aidActions.push(aidActionLabel(state, factionId, action.targetId, action.aidType))
    } else if (action.type === 'send_message') {
      messageTargets.push(targetToken(state, action.targetId))
    } else if (action.type === 'propose_ceasefire') {
      ceasefireTargets.push(targetToken(state, action.targetId))
    } else if (action.type === 'propose_peace') {
      peaceTargets.push(targetToken(state, action.targetId))
    } else if (action.type === 'mediate_peace') {
      mediationTargets.add(targetToken(state, action.sideAId))
      mediationTargets.add(targetToken(state, action.sideBId))
    } else if (action.type === 'respond_ceasefire') {
      responseActions.push(otherActionLabel(state, action))
    } else if (action.type === 'return_land') {
      returnLandActions.push(otherActionLabel(state, action))
    } else if (action.type !== 'end_turn') {
      other.push(otherActionLabel(state, action))
    }
  }

  const actionLines: string[] = []
  for (const [forceId, groups] of Object.entries(movesByForce)) {
    const dests = Object.entries(groups).map(([label, hexes]) => `${label}=[${hexes.join(' ')}]`)
    actionLines.push(`  move_force ${actorLabel(state, forceId)}: ${dests.join('; ')}`)
  }
  for (const claim of claimActions) actionLines.push(`  claim_hex ${claim}`)
  for (const strike of strikesByForce.values()) actionLines.push(`  force_strike ${strike.label} modes=[${[...strike.intensities].join('/')}]`)
  for (const strike of airStrikes.values()) actionLines.push(`  air_strike ${strike.label} modes=[${[...strike.intensities].join('/')}]`)
  if (tradeActions.length) actionLines.push(`  toggle_trade targets: [${tradeActions.join('; ')}]`)
  if (procurementActions.length) actionLines.push(`  procurement options: [${[...new Set(procurementActions)].join(', ')}]`)
  if (aidActions.length) actionLines.push(`  send_aid options: [${aidActions.join('; ')}]`)
  const diplomacyParts: string[] = []
  if (messageTargets.length) diplomacyParts.push(`send_message targets=[${messageTargets.join(', ')}]`)
  if (ceasefireTargets.length) diplomacyParts.push(`propose_ceasefire targets=[${ceasefireTargets.join(', ')}]`)
  if (peaceTargets.length) diplomacyParts.push(`propose_peace targets=[${peaceTargets.join(', ')}] returnHexes optional`)
  if (mediationTargets.size) diplomacyParts.push(`mediate_peace sides=[${[...mediationTargets].join(', ')}]`)
  if (responseActions.length) diplomacyParts.push(`respond=[${responseActions.join('; ')}]`)
  if (diplomacyParts.length) actionLines.push(`  diplomacy options: ${diplomacyParts.join('; ')}`)
  if (returnLandActions.length) actionLines.push(`  return_land options: [${returnLandActions.join('; ')}]`)
  if (other.length) actionLines.push(`  other: ${[...new Set(other)].join(', ')}`)

  if (faction.exiled) {
    return `You are ${faction.name}'s government in exile in Escalation, a geopolitical crisis simulation.

EXILE ROLE:
You no longer control cities, forces, procurement, trade policy, aid, or territory. Do not attempt military, procurement, embargo, aid, or land-return actions.
Act as an exiled political authority: issue public statements, message states, ask for ceasefires or peace, and mediate agreements that could restore security or legitimacy.

DECISION METHOD:
Treat recent actions as a question: What just happened, and what diplomatic response would best preserve your mandate, protect civilians, and create a historically plausible path back from exile?

${summary}

AVAILABLE ACTIONS:
${actionLines.join('\n') || '  (none - call end_turn)'}

Take your exile turn using the tools. You may take multiple diplomatic actions. When finished, call end_turn with a public pressStatement of no more than 3 sentences.`
  }

  return `You are ${faction.name} in Escalation, a geopolitical crisis simulation.

SIMULATION PURPOSE:
You are not trying to "win" like a normal board game. Act as a political actor using history as a reference: pursue your mandate, respect your doctrine and red lines, preserve domestic support, protect your economy, manage allies and rivals, and avoid reckless moves that would make no sense for your government or population.

ACTION JUDGMENT:
The actions below are legal game actions. Use force when it fits your mandate, red lines, doctrine, or a realistic response to recent events. Do not fire missiles or launch attacks for no political or military reason.
Moving an army onto land you do not own, attacking cities, and claiming disputed territory are major acts. Do them when your faction has a serious reason, and expect others to respond.

DECISION METHOD:
Treat the recent actions as a question you must answer: What just happened, and what response would best fulfill your objectives if this were real life and you were acting by historical precedent? Choose the legal tools that best match that answer, including military tools when the answer calls for force.

CEASEFIRE JUDGMENT:
Ceasefires are bilateral promises to stop hostile moves and strikes. If a ceasefire request is pending, answer it before doing anything else. Accept when continued fighting no longer serves your mandate or when a pause protects civilians, support, allies, or leverage. Reject only when the offer is bad faith, leaves a red-line violation unresolved, or would reward aggression.

DIPLOMATIC MESSAGES:
States can send messages to each other as a normal diplomatic action. Use send_message for warnings, demands, reassurance, coalition coordination, or ceasefire groundwork without taking military action. Keep messages under 3 sentences.
Peace offers and mediation are stronger diplomatic tools: use propose_peace or mediate_peace when a pause should include terms. Returning captured land is a major de-escalation signal and can be offered in peace terms.

EMBARGO JUDGMENT:
Embargo is a common diplomatic response that applies real pressure without committing to war. When another state attacks, seizes territory, threatens an ally, uses coercion, or violates an agreement, seriously consider an embargo as the practical middle step between sending a warning and using force. It hurts your economy as well as the target's, so avoid arbitrary embargoes against peaceful allies or neutrals, but do not reserve it only for extreme situations.

SEIZING CONTESTED TERRITORY:
Treat contested territory like Kashmir: moving forces onto it or claiming it is a de facto commitment to war if a rival claimant can fight back. Never seize it merely to signal weakness or because the move is available; do so only with a deliberate strategic objective and readiness for sustained conflict and diplomatic consequences.

${summary}

AVAILABLE ACTIONS:
${actionLines.join('\n') || '  (none - call end_turn)'}

Take your turn using the tools. You may take multiple actions. When finished, call end_turn with a public pressStatement of no more than 3 sentences explaining why you acted.`
}

function hexLabel(hex: Hex): string {
  return `(${hex.q},${hex.r})`
}

function actionContext(state: GameState, factionId: FactionId, action: Action): string {
  switch (action.type) {
    case 'move_force':
      return `[destination: ${tileContext(state, factionId, action.to, shouldWarnArmyEntry(state, action))}]`
    case 'force_strike':
    case 'air_strike': {
      const pressure = horizontalEscalationNote(state, factionId, action.target, action.intensity)
      return `[target: ${tileContext(state, factionId, action.target)}; ${targetContents(state, factionId, action.target)}${pressure ? `; ${pressure}` : ''}]`
    }
    default:
      return ''
  }
}

function moveDestinationGroupLabel(state: GameState, factionId: FactionId, action: Extract<Action, { type: 'move_force' }>): string {
  const tile = state.tiles[key(action.to)]
  if (!tile) return 'unknown'

  const parts: string[] = []
  if (!tile.owner) {
    parts.push('unclaimed')
  } else if (tile.owner === factionId) {
    parts.push('own')
  } else {
    const actor = state.factions[factionId]
    const owner = state.factions[tile.owner]
    const relation = owner?.alignment === 'neutral'
      ? 'neutral'
      : owner?.alignment === actor?.alignment
        ? 'ally'
        : 'opp'
    parts.push(relation)
    if (shouldWarnArmyEntry(state, action)) parts.push('war-entry')
  }
  if (tile.terrain !== 'plains') parts.push(tile.terrain)
  if (tile.dmz) parts.push('dmz')
  if (tile.contested) parts.push('front')
  if (tile.disputedBy?.length) parts.push(`disputed:${tile.disputedBy.join('/')}`)

  return parts.join('+')
}

function horizontalEscalationNote(
  state: GameState,
  factionId: FactionId,
  target: Hex,
  intensity: 'limited' | 'full',
): string | null {
  if (factionId !== 'volkaria' && factionId !== 'drovenia') return null
  if (recentCoalitionPressureOnKazrek(state).length === 0) return null
  const militaryTarget =
    forcesAtHex(state, target).some((force) => force.owner === 'tamarisk') ||
    installationsAt(state, target).some((inst) => inst.owner === 'tamarisk' && inst.type !== 'city')
  if (!militaryTarget) return null
  return intensity === 'limited'
    ? 'controlled horizontal-pressure option against Aurelia over recent coalition action against Kazrek; explain that link publicly'
    : 'full strike exceeds controlled Kazrek-linked pressure and risks wider war'
}

function tileContext(state: GameState, factionId: FactionId, hex: Hex, warnArmyEntry = false): string {
  const tile = state.tiles[key(hex)]
  if (!tile) return 'unknown hex'

  const parts = [ownershipContext(state, factionId, tile.owner)]
  if (warnArmyEntry && tile.owner && tile.owner !== factionId) parts.push('army entry is act of war')
  if (tile.terrain !== 'plains') parts.push(tile.terrain)
  if (tile.dmz) parts.push('DMZ')
  if (tile.contested) parts.push('front line')
  if (tile.disputedBy?.length) {
    parts.push(`disputed by ${tile.disputedBy.map((id) => state.factions[id]?.name ?? id).join(' and ')}`)
  }

  return parts.join(', ')
}

function shouldWarnArmyEntry(state: GameState, action: Extract<Action, { type: 'move_force' }>): boolean {
  const force = state.forces.find((candidate) => candidate.id === action.forceId)
  return force?.type === 'army_group' || force?.type === 'marine'
}

function ownershipContext(state: GameState, factionId: FactionId, ownerId: FactionId | null): string {
  if (!ownerId) return 'unclaimed'

  const owner = state.factions[ownerId]
  const actor = state.factions[factionId]
  if (!owner || !actor) return ownerId

  const relation =
    owner.id === factionId ? 'own'
    : owner.alignment === 'neutral' ? 'neutral'
    : owner.alignment === actor.alignment ? 'ally'
    : 'opp'

  return `${owner.id} ${relation} S${owner.support} E${owner.market}`
}

function targetContents(state: GameState, factionId: FactionId, hex: Hex): string {
  const contents: string[] = []
  const actor = state.factions[factionId]

  for (const inst of installationsAt(state, hex)) {
    const owner = state.factions[inst.owner]
    const warning = inst.type === 'city' ? ', city strike causes major diplomatic harm' : ''
    contents.push(`${owner?.id ?? inst.owner} ${installTypeToken(inst.type)} int${inst.integrity}${warning}`)
  }

  for (const force of forcesAtHex(state, hex)) {
    const owner = state.factions[force.owner]
    const relation = owner?.alignment === actor?.alignment ? 'same-align' : owner?.alignment === 'neutral' ? 'neutral' : 'opp'
    contents.push(`${owner?.id ?? force.owner} ${forceTypeToken(force.type)} ${force.health}/${force.maxHealth}, ${relation}`)
  }

  return contents.length ? `visible contents: ${contents.join('; ')}` : 'no visible force or installation on target'
}

function forceTypeToken(type: Force['type']): string {
  switch (type) {
    case 'army_group': return 'army'
    case 'marine': return 'marine'
    case 'naval_group': return 'navy'
    case 'missile_battery': return 'missile'
    default: return type
  }
}

function installTypeToken(type: Installation['type']): string {
  switch (type) {
    case 'army_base': return 'army_base'
    case 'air_base': return 'air_base'
    case 'naval_base': return 'naval_base'
    default: return type
  }
}

function actorLabel(state: GameState, forceId: string): string {
  const force = state.forces.find((candidate) => candidate.id === forceId)
  if (!force) return forceId
  return `${forceId}:${forceTypeToken(force.type)}@${hexLabel(force.hex)}`
}

function installationLabel(state: GameState, installId: string): string {
  const inst = state.installations.find((candidate) => candidate.id === installId)
  if (!inst) return installId
  return `${installId}:${installTypeToken(inst.type)}@${hexLabel(inst.hex)}`
}

function claimActionLabel(state: GameState, factionId: FactionId, forceId: string): string {
  const force = state.forces.find((candidate) => candidate.id === forceId)
  if (!force) return forceId
  const tile = state.tiles[key(force.hex)]
  const flashpoint = tile?.disputedBy?.length || tile?.dmz || tile?.contested
  const warning = flashpoint
    ? 'Kashmir-like flashpoint claim; only with serious political reasoning; expect response'
    : 'taking territory causes major diplomatic harm'
  return `${actorLabel(state, forceId)} at ${hexLabel(force.hex)} [claims: ${tileContext(state, factionId, force.hex)}; ${warning}]`
}

function otherActionLabel(state: GameState, action: Action): string {
  switch (action.type) {
    case 'set_procurement_policy':
      return `set_procurement_policy ${action.policy}`
    case 'set_procurement_burden':
      return `set_procurement_burden ${action.burden}`
    case 'start_procurement':
      return `start_procurement ${action.projectType}`
    case 'send_aid':
      return `send_aid ${state.factions[action.targetId]?.name ?? action.targetId} ${action.aidType}`
    case 'toggle_trade':
      return `toggle_trade ${state.factions[action.targetId]?.name ?? action.targetId}`
    case 'send_message':
      return `send_message ${targetToken(state, action.targetId)}`
    case 'propose_ceasefire':
      return `propose_ceasefire ${targetToken(state, action.targetId)}`
    case 'propose_peace':
      return `propose_peace ${targetToken(state, action.targetId)} (may include returnHexes)`
    case 'mediate_peace':
      return `mediate_peace ${targetToken(state, action.sideAId)}<->${targetToken(state, action.sideBId)}`
    case 'return_land':
      return `${hexLabel(action.hex)} -> ${targetToken(state, action.toId)}`
    case 'respond_ceasefire': {
      const request = (state.ceasefireRequests ?? []).find((item) => item.id === action.requestId)
      const from = request ? state.factions[request.from]?.name ?? request.from : action.requestId
      return `respond_ceasefire ${action.requestId} from ${from} [accept or reject before other actions]`
    }
    default:
      return action.type
  }
}

function aidActionLabel(state: GameState, factionId: FactionId, targetId: FactionId, aidType: string): string {
  const actor = state.factions[factionId]
  const target = state.factions[targetId]
  if (!actor || !target) return `${targetId} ${aidType}`
  const cost = aidType === 'economic'
    ? `econ ${actor.market}->${Math.max(0, actor.market - 6)}/${target.market}->${Math.min(100, target.market + 8)}`
    : `econ ${actor.market}->${Math.max(0, actor.market - 4)}, accelerates procurement`
  return `${targetToken(state, targetId)} ${aidType} (${cost})`
}

function tradeActionLabel(state: GameState, factionId: FactionId, targetId: FactionId): string {
  const actor = state.factions[factionId]
  const target = state.factions[targetId]
  if (!actor || !target) return targetId

  const currentlyEmbargoed = isEmbargoed(state, factionId, targetId)
  const next = toggleEmbargo(state, factionId, targetId)
  const actorAfter = next.factions[factionId]?.market ?? actor.market
  const targetAfter = next.factions[targetId]?.market ?? target.market
  const relation = target.alignment === 'neutral'
    ? 'neutral'
    : target.alignment === actor.alignment
      ? 'ally'
      : 'opposing bloc'

  if (currentlyEmbargoed) {
    return `${targetToken(state, targetId)} (${relation}, restore trade econ ${actor.market}->${actorAfter}/${target.market}->${targetAfter})`
  }

  const warning = target.alignment === 'neutral' || target.alignment === actor.alignment
    ? 'backlash risk'
    : 'pressure short of war'

  return `${targetToken(state, targetId)} (${relation}, embargo econ ${actor.market}->${actorAfter}/${target.market}->${targetAfter}, ${warning})`
}

function targetToken(state: GameState, targetId: FactionId): string {
  return state.factions[targetId] ? targetId : String(targetId)
}

function forcesAtHex(state: GameState, hex: Hex): Force[] {
  return state.forces.filter((force) => key(force.hex) === key(hex) && force.health > 0)
}

function installationsAt(state: GameState, hex: Hex): Installation[] {
  return state.installations.filter((inst) => key(inst.hex) === key(hex))
}
