import { availableActions, isEmbargoed, toggleEmbargo } from '../../src/game/engine.ts'
import type { Action } from '../../src/game/engine.ts'
import type { FactionId, Force, GameState, Hex, Installation, Tile } from '../../src/game/types.ts'
import { key } from '../../src/game/hexUtils.ts'
import { summarizeState } from '../summarize.ts'
import type { AgentTool } from './types.ts'

const FORCE_LABEL: Record<string, string> = {
  army_group: 'Army Group',
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
    description: 'Move or deploy a force to a hex. Entering land you do not own is an act of war.',
    input_schema: {
      type: 'object',
      properties: {
        forceId: { type: 'string', description: 'The ID of the force to move (e.g. "f3")' },
        to: {
          type: 'object',
          description: 'Destination hex coordinates',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
      },
      required: ['forceId', 'to'],
    },
  },
  {
    name: 'claim_hex',
    description: 'Claim the hex the force is currently standing on. Taking territory causes major diplomatic harm.',
    input_schema: {
      type: 'object',
      properties: {
        forceId: { type: 'string', description: 'The ID of the force claiming the hex' },
      },
      required: ['forceId'],
    },
  },
  {
    name: 'force_strike',
    description: 'Launch a missile or naval strike at a target hex.',
    input_schema: {
      type: 'object',
      properties: {
        forceId: { type: 'string', description: 'The force launching the strike' },
        target: {
          type: 'object',
          description: 'Target hex',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
        intensity: { type: 'string', enum: ['limited', 'full'], description: 'limited = 1 charge, full = 2 charges' },
      },
      required: ['forceId', 'target', 'intensity'],
    },
  },
  {
    name: 'air_strike',
    description: 'Launch an air strike from an air base.',
    input_schema: {
      type: 'object',
      properties: {
        baseId: { type: 'string', description: 'The air base installation ID' },
        target: {
          type: 'object',
          description: 'Target hex',
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
    description: 'Embargo or restore trade with another nation. Embargo is a diplomatic signal of disapproval, not a commitment to war.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'The faction ID to embargo or restore trade with.',
        },
      },
      required: ['targetId'],
    },
  },
  {
    name: 'set_procurement_policy',
    description: 'Set national procurement policy. Draft accelerates armies but harms support; contracts/emergency support hardware.',
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
    description: 'Set procurement burden. Higher burden builds faster but hurts economy/support.',
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
    description: 'Start or switch the active procurement project.',
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
    description: 'Send economic or arms aid to an ally. Aid costs you, helps the ally, and accelerates their procurement.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Allied faction ID receiving aid.' },
        aidType: { type: 'string', enum: ['economic', 'arms'] },
      },
      required: ['targetId', 'aidType'],
    },
  },
  {
    name: 'send_message',
    description: 'Send a diplomatic message to another nation without changing treaties or trade. Keep it under 3 sentences.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Faction ID receiving the message.' },
        message: { type: 'string', description: 'Short diplomatic message, maximum 3 sentences.', maxLength: 420 },
      },
      required: ['targetId', 'message'],
    },
  },
  {
    name: 'propose_ceasefire',
    description: 'Ask another nation for a bilateral ceasefire. If accepted, hostile moves and strikes between the pair are prohibited.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Faction ID receiving the ceasefire request.' },
        message: { type: 'string', description: 'Reasoned ceasefire proposal.', maxLength: 420 },
      },
      required: ['targetId', 'message'],
    },
  },
  {
    name: 'propose_peace',
    description: 'Offer a peace settlement to another nation. Can include returning captured land; if accepted, it creates a ceasefire.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: { type: 'string', description: 'Faction ID receiving the peace offer.' },
        message: { type: 'string', description: 'Short peace offer, maximum 3 sentences.', maxLength: 420 },
        returnHexes: {
          type: 'array',
          description: 'Optional captured hexes you offer to return.',
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
    description: 'Ask one nation to accept a mediated peace with another nation. If accepted, the two sides enter a ceasefire.',
    input_schema: {
      type: 'object',
      properties: {
        sideAId: { type: 'string', description: 'Faction ID receiving the mediation offer.' },
        sideBId: { type: 'string', description: 'Other faction the ceasefire would bind.' },
        message: { type: 'string', description: 'Short mediation message, maximum 3 sentences.', maxLength: 420 },
        returnHexes: {
          type: 'array',
          description: 'Optional hexes sideB would return to sideA if accepted.',
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
    description: 'Unilaterally return captured land to its prior owner as a diplomatic de-escalation.',
    input_schema: {
      type: 'object',
      properties: {
        hex: {
          type: 'object',
          description: 'Captured hex to return.',
          properties: { q: { type: 'number' }, r: { type: 'number' } },
          required: ['q', 'r'],
        },
        toId: { type: 'string', description: 'Faction ID receiving the returned land.' },
      },
      required: ['hex', 'toId'],
    },
  },
  {
    name: 'respond_ceasefire',
    description: 'Accept or reject a pending ceasefire request. Pending ceasefire requests must be answered before other actions.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Pending ceasefire request ID.' },
        response: { type: 'string', enum: ['accepted', 'rejected'] },
        message: { type: 'string', description: 'Short explanation of the response.', maxLength: 420 },
      },
      required: ['requestId', 'response', 'message'],
    },
  },
  {
    name: 'end_turn',
    description: 'Finish your turn. Include a short public press statement explaining your actions.',
    input_schema: {
      type: 'object',
      properties: {
        pressStatement: {
          type: 'string',
          description: 'A public press statement, maximum 3 sentences, explaining why your government took this turn.',
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
  const movesByForce: Record<string, string[]> = {}
  const claimActions: string[] = []
  const strikesByForce: string[] = []
  const airStrikes: string[] = []
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
      ;(movesByForce[action.forceId] ??= []).push(`${hexLabel(action.to)} ${actionContext(state, factionId, action)}`)
    } else if (action.type === 'claim_hex') {
      claimActions.push(claimActionLabel(state, factionId, action.forceId))
    } else if (action.type === 'force_strike') {
      strikesByForce.push(`${actorLabel(state, action.forceId)} -> ${hexLabel(action.target)} [${action.intensity}] ${actionContext(state, factionId, action)}`)
    } else if (action.type === 'air_strike') {
      airStrikes.push(`${installationLabel(state, action.baseId)} -> ${hexLabel(action.target)} [${action.intensity}] ${actionContext(state, factionId, action)}`)
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
  for (const [forceId, dests] of Object.entries(movesByForce))
    actionLines.push(`  move_force ${actorLabel(state, forceId)}: ${dests.join('; ')}`)
  for (const claim of claimActions) actionLines.push(`  claim_hex ${claim}`)
  for (const strike of strikesByForce) actionLines.push(`  force_strike ${strike}`)
  for (const strike of airStrikes) actionLines.push(`  air_strike ${strike}`)
  if (tradeActions.length) actionLines.push(`  toggle_trade targets: [${tradeActions.join('; ')}]`)
  if (procurementActions.length) actionLines.push(`  procurement options: [${[...new Set(procurementActions)].join(', ')}]`)
  if (aidActions.length) actionLines.push(`  send_aid options: [${aidActions.join('; ')}]`)
  const diplomacyParts: string[] = []
  if (messageTargets.length) diplomacyParts.push(`send_message targets=[${messageTargets.join(', ')}]`)
  if (ceasefireTargets.length) diplomacyParts.push(`propose_ceasefire targets=[${ceasefireTargets.join(', ')}]`)
  if (peaceTargets.length) diplomacyParts.push(`propose_peace targets=[${peaceTargets.join(', ')}] returnHexes optional`)
  if (mediationTargets.size) diplomacyParts.push(`mediate_peace side ids=[${[...mediationTargets].join(', ')}] choose sideAId and sideBId`)
  if (responseActions.length) diplomacyParts.push(`respond=[${responseActions.join('; ')}]`)
  if (diplomacyParts.length) actionLines.push(`  diplomacy options: ${diplomacyParts.join('; ')}`)
  if (returnLandActions.length) actionLines.push(`  return_land options: [${returnLandActions.join('; ')}]`)
  if (other.length) actionLines.push(`  other: ${[...new Set(other)].join(', ')}`)

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
Embargo is a diplomatic tool for signaling disapproval and applying pressure before committing to a war path. It hurts your own economy as well as the target's economy. Aggressively embargoing nations that have not taken hostile or aggressive acts can anger your own population, alarm allies, and look reckless. Use embargoes when there is a clear political reason: hostile action, coercion, treaty violation, direct threat, or deliberate pressure short of war.

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
    case 'air_strike':
      return `[target: ${tileContext(state, factionId, action.target)}; ${targetContents(state, factionId, action.target)}]`
    default:
      return ''
  }
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
  return force?.type === 'army_group'
}

function ownershipContext(state: GameState, factionId: FactionId, ownerId: FactionId | null): string {
  if (!ownerId) return 'unclaimed'

  const owner = state.factions[ownerId]
  const actor = state.factions[factionId]
  if (!owner || !actor) return ownerId

  const relation =
    owner.id === factionId ? 'own territory'
    : owner.alignment === 'neutral' ? 'neutral'
    : owner.alignment === actor.alignment ? 'ally'
    : 'opposing alignment'

  return `${owner.name} ${relation} (${owner.alignment}, support ${owner.support}, economy ${owner.market})`
}

function targetContents(state: GameState, factionId: FactionId, hex: Hex): string {
  const contents: string[] = []
  const actor = state.factions[factionId]

  for (const inst of installationsAt(state, hex)) {
    const owner = state.factions[inst.owner]
    const warning = inst.type === 'city' ? ', city strike causes major diplomatic harm' : ''
    contents.push(`${owner?.name ?? inst.owner} ${INSTALL_LABEL[inst.type] ?? inst.type} integrity ${inst.integrity}${warning}`)
  }

  for (const force of forcesAtHex(state, hex)) {
    const owner = state.factions[force.owner]
    const relation = owner?.alignment === actor?.alignment ? 'same alignment' : owner?.alignment === 'neutral' ? 'neutral' : 'opposing alignment'
    contents.push(`${owner?.name ?? force.owner} ${FORCE_LABEL[force.type] ?? force.type} ${force.health}/${force.maxHealth} HP, ${relation}`)
  }

  return contents.length ? `visible contents: ${contents.join('; ')}` : 'no visible force or installation on target'
}

function actorLabel(state: GameState, forceId: string): string {
  const force = state.forces.find((candidate) => candidate.id === forceId)
  if (!force) return forceId
  return `${forceId} ${FORCE_LABEL[force.type] ?? force.type} at ${hexLabel(force.hex)}`
}

function installationLabel(state: GameState, installId: string): string {
  const inst = state.installations.find((candidate) => candidate.id === installId)
  if (!inst) return installId
  return `${installId} ${INSTALL_LABEL[inst.type] ?? inst.type} at ${hexLabel(inst.hex)}`
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
  return `${targetId}=${state.factions[targetId]?.name ?? targetId}`
}

function forcesAtHex(state: GameState, hex: Hex): Force[] {
  return state.forces.filter((force) => key(force.hex) === key(hex) && force.health > 0)
}

function installationsAt(state: GameState, hex: Hex): Installation[] {
  return state.installations.filter((inst) => key(inst.hex) === key(hex))
}
