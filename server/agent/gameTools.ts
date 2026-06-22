import { availableActions, dispatch } from '../../src/game/engine.ts'
import type { Action, StrikeIntensity } from '../../src/game/engine.ts'
import type { AidPackageType, CeasefireResponse, ProcurementBurden, ProcurementPolicy, ProcurementProjectType } from '../../src/game/types.ts'
import type { GameState, Hex } from '../../src/game/types.ts'
import type { ModelToolCall } from './types.ts'

export type GameToolExecution = {
  state: GameState
  action?: Action
  logEntry?: string
  resultText: string
  isError?: boolean
  endedTurn?: boolean
  pressStatement?: string
}

export function executeGameToolCall(state: GameState, call: ModelToolCall): GameToolExecution {
  if (call.unsupportedType) {
    const message = `Unsupported tool call type: ${call.unsupportedType}`
    return errorResult(state, message)
  }

  if (call.name === 'end_turn') {
    const pressStatement = cleanPressStatement(call.input.pressStatement)
    if (!pressStatement) {
      return errorResult(state, 'end_turn requires a pressStatement of no more than 3 sentences.')
    }

    return {
      state: dispatch(state, { type: 'end_turn' }),
      action: { type: 'end_turn' },
      logEntry: 'end_turn',
      resultText: 'Turn ended.',
      endedTurn: true,
      pressStatement,
    }
  }

  const action = parseAction(call.name, call.input)
  if (!action) {
    return errorResult(state, `Could not parse action: ${call.name}`)
  }

  if (!isLegal(action, availableActions(state))) {
    return errorResult(state, `Action not available: ${JSON.stringify(action)}`, 'ILLEGAL')
  }

  const nextState = dispatch(state, action)
  const summary = actionSummary(action)
  return {
    state: nextState,
    action,
    logEntry: summary,
    resultText: `OK - ${summary}`,
  }
}

function cleanPressStatement(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return undefined

  const sentences = trimmed.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [trimmed]
  return sentences.slice(0, 3).join(' ').slice(0, 420).trim()
}

export function forceEndTurn(state: GameState): GameToolExecution {
  return {
    state: dispatch(state, { type: 'end_turn' }),
    action: { type: 'end_turn' },
    resultText: 'Turn ended automatically.',
    endedTurn: true,
  }
}

function errorResult(state: GameState, message: string, prefix = 'ERROR'): GameToolExecution {
  return {
    state,
    logEntry: `${prefix}: ${message}`,
    resultText: message,
    isError: true,
  }
}

function parseAction(name: string, input: Record<string, unknown>): Action | null {
  try {
    switch (name) {
      case 'move_force':
        return { type: 'move_force', forceId: input.forceId as string, to: input.to as { q: number; r: number } }
      case 'claim_hex':
        return { type: 'claim_hex', forceId: input.forceId as string }
      case 'force_strike':
        return {
          type: 'force_strike',
          forceId: input.forceId as string,
          target: input.target as { q: number; r: number },
          intensity: input.intensity as StrikeIntensity,
        }
      case 'air_strike':
        return {
          type: 'air_strike',
          baseId: input.baseId as string,
          target: input.target as { q: number; r: number },
          intensity: input.intensity as StrikeIntensity,
        }
      case 'toggle_trade':
        return { type: 'toggle_trade', targetId: input.targetId as string }
      case 'set_procurement_policy':
        return { type: 'set_procurement_policy', policy: input.policy as ProcurementPolicy }
      case 'set_procurement_burden':
        return { type: 'set_procurement_burden', burden: input.burden as ProcurementBurden }
      case 'start_procurement':
        return { type: 'start_procurement', projectType: input.projectType as ProcurementProjectType }
      case 'send_aid':
        return { type: 'send_aid', targetId: input.targetId as string, aidType: input.aidType as AidPackageType }
      case 'send_message':
        return { type: 'send_message', targetId: input.targetId as string, message: input.message as string }
      case 'propose_ceasefire':
        return { type: 'propose_ceasefire', targetId: input.targetId as string, message: input.message as string }
      case 'propose_peace':
        return {
          type: 'propose_peace',
          targetId: input.targetId as string,
          message: input.message as string,
          returnHexes: parseHexes(input.returnHexes),
        }
      case 'mediate_peace':
        return {
          type: 'mediate_peace',
          sideAId: input.sideAId as string,
          sideBId: input.sideBId as string,
          message: input.message as string,
          returnHexes: parseHexes(input.returnHexes),
        }
      case 'return_land':
        return { type: 'return_land', hex: input.hex as { q: number; r: number }, toId: input.toId as string }
      case 'respond_ceasefire':
        return {
          type: 'respond_ceasefire',
          requestId: input.requestId as string,
          response: input.response as CeasefireResponse,
          message: input.message as string,
        }
      default:
        return null
    }
  } catch {
    return null
  }
}

function parseHexes(value: unknown): Hex[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Hex =>
    !!item &&
    typeof item === 'object' &&
    typeof (item as Hex).q === 'number' &&
    typeof (item as Hex).r === 'number',
  )
}

function isLegal(action: Action, available: Action[]): boolean {
  // Exact match on all fields; availableActions already enumerates every legal option.
  return available.some((candidate) => {
    if (candidate.type !== action.type) return false
    if (action.type === 'send_message' && candidate.type === 'send_message')
      return candidate.targetId === action.targetId
    if (action.type === 'propose_ceasefire' && candidate.type === 'propose_ceasefire')
      return candidate.targetId === action.targetId
    if (action.type === 'propose_peace' && candidate.type === 'propose_peace')
      return candidate.targetId === action.targetId
    if (action.type === 'mediate_peace' && candidate.type === 'mediate_peace')
      return candidate.sideAId === action.sideAId && candidate.sideBId === action.sideBId
    if (action.type === 'respond_ceasefire' && candidate.type === 'respond_ceasefire')
      return candidate.requestId === action.requestId && candidate.response === action.response
    return JSON.stringify(candidate) === JSON.stringify(action)
  })
}

function actionSummary(action: Action): string {
  switch (action.type) {
    case 'move_force':   return `Force ${action.forceId} -> (${action.to.q},${action.to.r})`
    case 'claim_hex':    return `Force ${action.forceId} claims hex`
    case 'force_strike': return `${action.intensity} strike from ${action.forceId} -> (${action.target.q},${action.target.r})`
    case 'air_strike':   return `${action.intensity} air strike from ${action.baseId} -> (${action.target.q},${action.target.r})`
    case 'toggle_trade':  return `Toggles trade with ${action.targetId}`
    case 'set_procurement_policy': return `Sets procurement policy to ${action.policy}`
    case 'set_procurement_burden': return `Sets procurement burden to ${action.burden}`
    case 'start_procurement': return `Starts procurement: ${action.projectType}`
    case 'send_aid': return `Sends ${action.aidType} aid to ${action.targetId}`
    case 'send_message': return `Sends message to ${action.targetId}`
    case 'propose_ceasefire': return `Proposes ceasefire to ${action.targetId}`
    case 'propose_peace': return `Offers peace to ${action.targetId}`
    case 'mediate_peace': return `Mediates peace between ${action.sideAId} and ${action.sideBId}`
    case 'return_land': return `Returns (${action.hex.q},${action.hex.r}) to ${action.toId}`
    case 'respond_ceasefire': return `${action.response} ceasefire request ${action.requestId}`
    default:             return action.type
  }
}
