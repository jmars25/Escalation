import type {
  Action,
  DecisionAssessment,
  DecisionRisk,
  Faction,
  Hex,
} from '../../src/game/types.ts'
import type { ActionCatalogEntry } from './factionAgent.ts'
import type { ModelToolCall } from './types.ts'

export const MAX_TURN_ACTIONS = 4

export type ParsedTurnPlan = {
  assessment: DecisionAssessment
  plannedActions: Action[]
  pressStatement: string
}

export type TurnPlanParseResult =
  | { plan: ParsedTurnPlan; error?: never }
  | { plan?: never; error: string }

export function parseTurnPlan(
  call: ModelToolCall | undefined,
  catalog: ActionCatalogEntry[],
  faction: Faction,
): TurnPlanParseResult {
  if (!call || call.name !== 'submit_turn_plan' || call.unsupportedType) {
    return { error: 'Call submit_turn_plan exactly once.' }
  }

  const assessmentInput = asObject(call.input.assessment)
  const situation = cleanText(assessmentInput.situation, 220)
  const intent = cleanText(assessmentInput.intent, 180)
  const pressStatement = cleanText(call.input.pressStatement, 420, 3)
  const risk = assessmentInput.risk
  if (!situation || !intent || !pressStatement || !isDecisionRisk(risk)) {
    return { error: 'Assessment situation, intent, risk, and a short pressStatement are required.' }
  }

  const actionInputs = Array.isArray(call.input.actions) ? call.input.actions.slice(0, MAX_TURN_ACTIONS) : []
  const catalogById = new Map(catalog.map((entry) => [entry.id, entry.action]))
  const usedIds = new Set<string>()
  const plannedActions: Action[] = []

  for (const raw of actionInputs) {
    const item = asObject(raw)
    const actionId = typeof item.actionId === 'string' ? item.actionId : ''
    const template = catalogById.get(actionId)
    if (!template) return { error: `Unknown or unavailable actionId ${actionId || '(missing)'}.` }
    if (usedIds.has(actionId)) return { error: `Action ${actionId} was selected more than once.` }
    usedIds.add(actionId)
    const materialized = materializeAction(template, item)
    if (!materialized) return { error: `Action ${actionId} requires a non-empty diplomatic message.` }
    plannedActions.push(materialized)
  }

  if (catalog.some((entry) => entry.action.type === 'respond_ceasefire') && !plannedActions.some((action) => action.type === 'respond_ceasefire')) {
    return { error: 'A pending ceasefire must be accepted or rejected before the turn can continue.' }
  }

  const alternatives = Array.isArray(assessmentInput.alternatives)
    ? assessmentInput.alternatives.slice(0, 3).flatMap((raw) => {
        const item = asObject(raw)
        const option = cleanText(item.option, 120)
        const rejectedBecause = cleanText(item.rejectedBecause, 160)
        return option && rejectedBecause ? [{ option, rejectedBecause }] : []
      })
    : []

  return {
    plan: {
      assessment: {
        situation,
        intent,
        objectiveIndexes: cleanIndexes(assessmentInput.objectiveIndexes, faction.objectives.length),
        redLineIndexes: cleanIndexes(assessmentInput.redLineIndexes, faction.redLines.length),
        confidence: clampInteger(assessmentInput.confidence, 0, 100, 50),
        risk,
        alternatives,
      },
      plannedActions,
      pressStatement,
    },
  }
}

export function actionToToolCall(action: Action, index: number): ModelToolCall {
  const { type, ...input } = action
  return { id: `plan-action-${index}`, name: type, input }
}

export function fallbackAssessment(faction: Faction, reason: string): DecisionAssessment {
  return {
    situation: cleanText(reason, 220) || 'The government could not produce a valid structured assessment.',
    intent: 'Maintain the current posture while the cabinet reassesses its options.',
    objectiveIndexes: faction.objectives.length ? [0] : [],
    redLineIndexes: [],
    confidence: 20,
    risk: 'medium',
    alternatives: [],
  }
}

function materializeAction(template: Action, input: Record<string, unknown>): Action | null {
  const message = cleanText(input.message, 420, 3)
  const returnHexes = cleanHexes(input.returnHexes)
  switch (template.type) {
    case 'send_message':
    case 'propose_ceasefire':
      return message ? { ...template, message } : null
    case 'propose_peace':
      return message ? { ...template, message, returnHexes } : null
    case 'mediate_peace':
      return message ? { ...template, message, returnHexes } : null
    case 'respond_ceasefire':
      return {
        ...template,
        message: message || (template.response === 'accepted'
          ? 'We accept the proposed ceasefire.'
          : 'We reject the proposed ceasefire under the current conditions.'),
      }
    default:
      return structuredClone(template)
  }
}

function cleanHexes(value: unknown): Hex[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.slice(0, 8).flatMap((raw) => {
    const item = asObject(raw)
    if (!Number.isFinite(item.q) || !Number.isFinite(item.r)) return []
    const hex = { q: Number(item.q), r: Number(item.r) }
    const id = `${hex.q},${hex.r}`
    if (seen.has(id)) return []
    seen.add(id)
    return [hex]
  })
}

function cleanIndexes(value: unknown, length: number): number[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is number => Number.isInteger(item) && item >= 0 && item < length)
    .slice(0, 3))]
}

function cleanText(value: unknown, max: number, sentences?: number): string {
  if (typeof value !== 'string') return ''
  const compact = value.trim().replace(/\s+/g, ' ')
  if (!sentences) return compact.slice(0, max).trim()
  const parts = compact.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [compact]
  return parts.slice(0, sentences).join(' ').slice(0, max).trim()
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function isDecisionRisk(value: unknown): value is DecisionRisk {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'catastrophic'
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback
}
