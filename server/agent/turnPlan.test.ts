import { describe, expect, it } from 'vitest'
import { availableActions } from '../../src/game/engine.ts'
import { key } from '../../src/game/hexUtils.ts'
import { buildInitialState } from '../../src/game/scenario.ts'
import { buildActionCatalog, TURN_PLAN_TOOL } from './factionAgent.ts'
import { MAX_TURN_ACTIONS, parseTurnPlan } from './turnPlan.ts'
import type { ModelToolCall } from './types.ts'

function planCall(actions: unknown[] = []): ModelToolCall {
  return {
    id: 'plan-1',
    name: 'submit_turn_plan',
    input: {
      assessment: {
        situation: 'The flashpoint is tense but contained.',
        intent: 'Signal resolve without beginning a general war.',
        objectiveIndexes: [0, 999, 0],
        redLineIndexes: [0],
        confidence: 73.4,
        risk: 'medium',
        alternatives: [
          { option: 'Attack immediately', rejectedBecause: 'It creates needless escalation.' },
        ],
      },
      actions,
      pressStatement: 'We remain ready to defend our interests.',
    },
  }
}

describe('parseTurnPlan', () => {
  it('turns short catalog ids into authoritative game actions', () => {
    const state = buildInitialState()
    const faction = state.factions.aurelia
    const catalog = buildActionCatalog(state, faction.id)
    const policy = catalog.find((entry) => entry.action.type === 'set_procurement_policy')
    expect(policy).toBeDefined()

    const result = parseTurnPlan(planCall([{ actionId: policy!.id }]), catalog, faction)

    expect(result.error).toBeUndefined()
    expect(result.plan?.plannedActions).toEqual([policy!.action])
    expect(result.plan?.assessment.objectiveIndexes).toEqual([0])
    expect(result.plan?.assessment.confidence).toBe(73)
  })

  it('rejects unavailable and duplicate action ids', () => {
    const state = buildInitialState()
    const faction = state.factions.aurelia
    const catalog = buildActionCatalog(state, faction.id)
    const first = catalog[0]

    expect(parseTurnPlan(planCall([{ actionId: 'A999' }]), catalog, faction).error)
      .toContain('Unknown or unavailable')
    expect(parseTurnPlan(planCall([{ actionId: first.id }, { actionId: first.id }]), catalog, faction).error)
      .toContain('more than once')
  })

  it('requires prose only for the diplomatic actions that need it', () => {
    const state = buildInitialState()
    const faction = state.factions.aurelia
    const catalog = buildActionCatalog(state, faction.id)
    const message = catalog.find((entry) => entry.action.type === 'send_message')
    expect(message).toBeDefined()

    const missing = parseTurnPlan(planCall([{ actionId: message!.id }]), catalog, faction)
    const provided = parseTurnPlan(
      planCall([{ actionId: message!.id, message: 'We invite immediate consultations.' }]),
      catalog,
      faction,
    )

    expect(missing.error).toContain('non-empty diplomatic message')
    expect(provided.plan?.plannedActions[0]).toMatchObject({
      type: 'send_message', message: 'We invite immediate consultations.',
    })
  })

  it('caps a plan at the bounded action budget', () => {
    const state = buildInitialState()
    const faction = state.factions.aurelia
    const catalog = buildActionCatalog(state, faction.id)
    const selections = catalog
      .filter((entry) => !['send_message', 'propose_ceasefire', 'propose_peace', 'mediate_peace'].includes(entry.action.type))
      .slice(0, MAX_TURN_ACTIONS + 1)
      .map((entry) => ({ actionId: entry.id }))

    const result = parseTurnPlan(planCall(selections), catalog, faction)

    expect(result.plan?.plannedActions).toHaveLength(MAX_TURN_ACTIONS)
  })
})

describe('turn-plan token guardrails', () => {
  it('caps routine moves while retaining every escalatory move', () => {
    const state = buildInitialState()
    const factionId = state.order[state.turnIndex]
    const catalog = buildActionCatalog(state, factionId)
    const catalogActions = new Set(catalog.map((entry) => JSON.stringify(entry.action)))
    const routineMoves = new Map<string, number>()

    for (const entry of catalog) {
      if (entry.action.type !== 'move_force') continue
      const tile = state.tiles[key(entry.action.to)]
      const routine = (tile?.owner === factionId || !tile?.owner) &&
        !tile?.contested && !tile?.dmz && !tile?.disputedBy?.length
      if (routine) routineMoves.set(entry.action.forceId, (routineMoves.get(entry.action.forceId) ?? 0) + 1)
    }

    expect([...routineMoves.values()].every((count) => count <= 4)).toBe(true)
    expect(catalog.some((entry) => entry.action.type === 'end_turn')).toBe(false)

    const escalatoryMoves = availableActions(state).filter((action) => {
      if (action.type !== 'move_force') return false
      const tile = state.tiles[key(action.to)]
      return !((tile?.owner === factionId || !tile?.owner) &&
        !tile?.contested && !tile?.dmz && !tile?.disputedBy?.length)
    })
    expect(escalatoryMoves.length).toBeGreaterThan(0)
    for (const action of escalatoryMoves) expect(catalogActions.has(JSON.stringify(action))).toBe(true)
  })

  it('keeps every object in the strict planner schema closed and fully required', () => {
    const visit = (node: unknown): void => {
      if (!node || typeof node !== 'object') return
      const schema = node as Record<string, unknown>
      if (schema.type === 'object') {
        const properties = schema.properties as Record<string, unknown>
        expect(schema.additionalProperties).toBe(false)
        expect(new Set(schema.required as string[])).toEqual(new Set(Object.keys(properties)))
        Object.values(properties).forEach(visit)
      }
      if (schema.type === 'array') visit(schema.items)
    }

    visit(TURN_PLAN_TOOL.input_schema)
  })
})
