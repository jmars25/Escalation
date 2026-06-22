import { respondMediation } from '../../src/game/engine.ts'
import type { Action } from '../../src/game/engine.ts'
import type { FactionId, GameState } from '../../src/game/types.ts'
import { buildSystemPrompt } from './factionAgent.ts'
import { forceEndTurn, executeGameToolCall } from './gameTools.ts'
import { runCeasefireResponse, runPeaceDecision } from './diplomacy.ts'
import { agentRuntimeConfig, createAgentModelAdapter } from './provider.ts'
import type { AgentResult, ModelToolResult } from './types.ts'

const MAX_AGENT_STEPS = 20

export async function runAgentTurn(
  state: GameState,
  factionId: FactionId,
): Promise<AgentResult> {
  const config = agentRuntimeConfig()
  if (!config.hasKey) throw new Error(`${config.keyEnv} not set`)

  const adapter = createAgentModelAdapter(config)
  const actions: Action[] = []
  const log: string[] = []
  let currentState = state
  let pressStatement: string | undefined

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const systemPrompt = buildSystemPrompt(currentState, factionId)
    if (step === 0) logInitialPrompt(config.provider, config.model, factionId, systemPrompt)
    const toolCalls = await adapter.nextTurn(systemPrompt)
    if (toolCalls.length === 0) break

    const toolResults: ModelToolResult[] = []

    for (const call of toolCalls) {
      const execution = executeGameToolCall(currentState, call)
      currentState = execution.state

      if (execution.action) actions.push(execution.action)
      if (execution.logEntry) log.push(execution.logEntry)
      if (execution.pressStatement) pressStatement = execution.pressStatement

      if (execution.action && !execution.isError) {
        const resolved = await resolveImmediateDiplomacy(currentState, execution.action)
        currentState = resolved.state
        if (resolved.logEntry) log.push(resolved.logEntry)
      }

      toolResults.push({
        id: call.id,
        content: execution.resultText,
        isError: execution.isError,
      })

      if (execution.endedTurn) {
        if (pressStatement) currentState = appendPressStatement(currentState, factionId, pressStatement)
        adapter.addToolResults(toolResults)
        return { actions, finalState: currentState, log, pressStatement }
      }
    }

    adapter.addToolResults(toolResults)
  }

  const fallback = forceEndTurn(currentState)
  currentState = fallback.state
  if (fallback.action) actions.push(fallback.action)

  return { actions, finalState: currentState, log, pressStatement }
}

function logInitialPrompt(provider: string, model: string, factionId: FactionId, prompt: string): void {
  console.log(`\n[agent-prompt:start] provider=${provider} model=${model} faction=${factionId}`)
  console.log('--- prompt begin ---')
  console.log(prompt)
  console.log('--- prompt end ---\n')
}

function appendPressStatement(state: GameState, factionId: FactionId, statement: string): GameState {
  const pressEvent: GameState['log'][number] = {
    turn: state.turn,
    kind: 'dispatch',
    faction: factionId,
    text: `${state.factions[factionId].name} press statement: "${statement}"`,
  }

  const nextLog = [pressEvent, ...state.log].slice(0, 200)

  return {
    ...state,
    log: nextLog,
  }
}

async function resolveImmediateDiplomacy(
  state: GameState,
  action: Action,
): Promise<{ state: GameState; logEntry?: string }> {
  if (action.type === 'propose_ceasefire' || action.type === 'propose_peace') {
    if (state.factions[action.targetId]?.type === 'player') return { state }
    const request = (state.ceasefireRequests ?? []).find((item) =>
      item.from === currentFactionIdFromState(state) &&
      item.to === action.targetId &&
      (action.type === 'propose_peace' ? item.kind === 'peace_offer' : item.kind === 'ceasefire'),
    )
    if (!request) return { state }
    const result = await runCeasefireResponse(state, request.id)
    return {
      state: result.finalState,
      logEntry: `${state.factions[action.targetId]?.name ?? action.targetId} ${result.response} ${request.kind === 'peace_offer' ? 'peace offer' : 'ceasefire request'}`,
    }
  }

  if (action.type === 'mediate_peace') {
    const sideA = state.factions[action.sideAId]
    const sideB = state.factions[action.sideBId]
    if (!sideA || !sideB || sideA.type === 'player' || sideB.type === 'player') return { state }
    const request = (state.ceasefireRequests ?? []).find((item) =>
      item.kind === 'mediation' &&
      item.from === currentFactionIdFromState(state) &&
      item.to === action.sideAId &&
      item.counterpartId === action.sideBId,
    )
    if (!request) return { state }

    const mediatorId = currentFactionIdFromState(state)
    const proposalMessage = typeof action.message === 'string' && action.message.trim()
      ? action.message
      : 'We accept our own mediation proposal.'
    const sideADecision = action.sideAId === mediatorId
      ? { response: 'accepted' as const, message: proposalMessage, pressStatement: proposalMessage }
      : await runPeaceDecision(state, request.id, action.sideAId)
    const sideBDecision = action.sideBId === mediatorId
      ? { response: 'accepted' as const, message: proposalMessage, pressStatement: proposalMessage }
      : await runPeaceDecision(state, request.id, action.sideBId)
    const finalState = respondMediation(
      state,
      request.id,
      sideADecision.response,
      sideADecision.pressStatement,
      sideBDecision.response,
      sideBDecision.pressStatement,
    )
    return {
      state: finalState,
      logEntry: `Mediation response: ${sideA.name} ${sideADecision.response}, ${sideB.name} ${sideBDecision.response}`,
    }
  }

  return { state }
}

function currentFactionIdFromState(state: GameState): FactionId {
  return state.order[state.turnIndex]
}
