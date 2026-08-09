import { beforeEach, describe, expect, it, vi } from 'vitest'

const model = vi.hoisted(() => ({
  nextTurn: vi.fn(),
  addToolResults: vi.fn(),
}))

vi.mock('./provider.ts', () => ({
  agentRuntimeConfig: vi.fn(() => ({
    provider: 'openai',
    model: 'gpt-test',
    keyEnv: 'OPENAI_API_KEY',
    hasKey: true,
  })),
  createAgentModelAdapter: vi.fn(() => model),
}))

import { buildInitialState } from '../../src/game/scenario.ts'
import { runAgentTurn } from './harness.ts'

function validPlan() {
  return {
    toolCalls: [{
      id: 'plan-1',
      name: 'submit_turn_plan',
      input: {
        assessment: {
          situation: 'The front is tense but currently stable.',
          intent: 'Preserve room for diplomacy.',
          objectiveIndexes: [0],
          redLineIndexes: [],
          confidence: 68,
          risk: 'low',
          alternatives: [{ option: 'Escalate', rejectedBecause: 'The costs exceed the gains.' }],
        },
        actions: [],
        pressStatement: 'We favor a peaceful and credible resolution.',
      },
    }],
    usage: { inputTokens: 120, outputTokens: 34, cachedInputTokens: 80 },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

describe('runAgentTurn structured planner', () => {
  it('uses one model call for a valid turn and records cost telemetry', async () => {
    model.nextTurn.mockResolvedValue(validPlan())

    const result = await runAgentTurn(buildInitialState(), 'aurelia')

    expect(model.nextTurn).toHaveBeenCalledTimes(1)
    expect(result.actions).toEqual([{ type: 'end_turn' }])
    expect(result.decision?.telemetry).toMatchObject({
      provider: 'openai',
      model: 'gpt-test',
      modelCalls: 1,
      inputTokens: 120,
      outputTokens: 34,
      cachedInputTokens: 80,
      promptVersion: 'turn-plan-v1',
    })
    expect(result.finalState.decisions?.[0]).toEqual(result.decision)
    expect(result.finalState.turnIndex).toBe(1)
  })

  it('allows only one repair call and aggregates both calls usage', async () => {
    const malformed = validPlan()
    malformed.toolCalls[0].input.assessment.risk = 'reckless'
    model.nextTurn
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(validPlan())

    const result = await runAgentTurn(buildInitialState(), 'aurelia')

    expect(model.nextTurn).toHaveBeenCalledTimes(2)
    expect(model.addToolResults).toHaveBeenCalledTimes(1)
    expect(result.decision?.telemetry).toMatchObject({
      modelCalls: 2,
      inputTokens: 240,
      outputTokens: 68,
      cachedInputTokens: 160,
    })
  })

  it('falls back safely without entering an unbounded agent loop', async () => {
    model.nextTurn.mockResolvedValue({ toolCalls: [], usage: { inputTokens: 44, outputTokens: 2 } })

    const result = await runAgentTurn(buildInitialState(), 'aurelia')

    expect(model.nextTurn).toHaveBeenCalledTimes(1)
    expect(result.actions).toEqual([{ type: 'end_turn' }])
    expect(result.log[0]).toContain('Structured plan fallback')
    expect(result.decision?.assessment.confidence).toBe(20)
  })
})
