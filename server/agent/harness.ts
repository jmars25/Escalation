import { respondMediation } from '../../src/game/engine.ts'
import type { Action } from '../../src/game/engine.ts'
import type { DecisionExecution, DecisionRecord, FactionId, GameState } from '../../src/game/types.ts'
import {
  buildActionCatalog,
  buildTurnPlanPrompt,
  TURN_PLAN_PROMPT_VERSION,
  TURN_PLAN_TOOL,
} from './factionAgent.ts'
import { forceEndTurn, executeGameToolCall } from './gameTools.ts'
import { runCeasefireResponse, runPeaceDecision } from './diplomacy.ts'
import { agentRuntimeConfig, createAgentModelAdapter } from './provider.ts'
import { actionToToolCall, fallbackAssessment, parseTurnPlan, type ParsedTurnPlan } from './turnPlan.ts'
import type { AgentResult, AgentRuntimeConfig, ModelToolResult, ModelUsage } from './types.ts'

const MAX_PLAN_ATTEMPTS = 2
const MAX_DECISIONS = 100

export async function runAgentTurn(
  state: GameState,
  factionId: FactionId,
): Promise<AgentResult> {
  const config = agentRuntimeConfig()
  if (!config.hasKey) throw new Error(`${config.keyEnv} not set`)
  if (currentFactionIdFromState(state) !== factionId) {
    throw new Error(`Faction ${factionId} cannot act during ${currentFactionIdFromState(state)}'s turn`)
  }

  const startedAt = Date.now()
  const catalog = buildActionCatalog(state, factionId)
  const systemPrompt = buildTurnPlanPrompt(state, factionId, catalog)
  const adapter = createAgentModelAdapter(config, [TURN_PLAN_TOOL], 'Submit your bounded turn plan now.')
  const actions: Action[] = []
  const log: string[] = []
  let currentState = state
  const usage: ModelUsage = {}
  let modelCalls = 0
  let plan: ParsedTurnPlan | undefined
  let planError = 'The model returned no structured turn plan.'

  logInitialPrompt(config.provider, config.model, factionId, systemPrompt)
  for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt++) {
    const turn = await adapter.nextTurn(systemPrompt)
    modelCalls += 1
    mergeUsage(usage, turn.usage)
    if (turn.toolCalls.length === 0) break

    const planCall = turn.toolCalls.find((call) => call.name === TURN_PLAN_TOOL.name)
    const parsed = parseTurnPlan(planCall, catalog, state.factions[factionId])
    if (parsed.plan) {
      plan = parsed.plan
      break
    }

    planError = parsed.error
    const toolResults: ModelToolResult[] = turn.toolCalls.map((call) => ({
      id: call.id,
      content: call === planCall ? planError : 'Only submit_turn_plan is allowed for this turn.',
      isError: true,
    }))
    adapter.addToolResults(toolResults)
  }

  if (!plan) {
    const pressStatement = 'The government is reviewing the situation and will maintain its present posture.'
    currentState = appendPressStatement(currentState, factionId, pressStatement)
    const fallback = forceEndTurn(currentState)
    currentState = fallback.state
    if (fallback.action) actions.push(fallback.action)
    const executions: DecisionExecution[] = fallback.action
      ? [{ action: fallback.action, status: 'applied', result: fallback.resultText }]
      : []
    const decision = makeDecisionRecord({
      state,
      factionId,
      assessment: fallbackAssessment(state.factions[factionId], planError),
      plannedActions: [],
      executions,
      publicStatement: pressStatement,
      config,
      modelCalls,
      usage,
      startedAt,
    })
    currentState = appendDecision(currentState, decision)
    log.push(`Structured plan fallback: ${planError}`)
    return { actions, finalState: currentState, log, pressStatement, decision }
  }

  const executions: DecisionExecution[] = []
  let awaitingPlayerResponse = false
  for (const [index, plannedAction] of plan.plannedActions.entries()) {
    const before = currentState
    const execution = executeGameToolCall(currentState, actionToToolCall(plannedAction, index))
    currentState = execution.state
    const status = execution.isError ? 'illegal' : currentState === before ? 'no_op' : 'applied'
    executions.push({ action: plannedAction, status, result: execution.resultText })
    if (execution.logEntry) log.push(execution.logEntry)
    if (execution.action && !execution.isError && status === 'applied') actions.push(execution.action)

    if (execution.action && !execution.isError && status === 'applied') {
      const resolved = await resolveImmediateDiplomacy(currentState, execution.action)
      currentState = resolved.state
      awaitingPlayerResponse = !!resolved.awaitingPlayerResponse
      if (resolved.logEntry) log.push(resolved.logEntry)
    }
    if (awaitingPlayerResponse) break
  }

  if (!awaitingPlayerResponse) {
    currentState = appendPressStatement(currentState, factionId, plan.pressStatement)
    const ended = forceEndTurn(currentState)
    currentState = ended.state
    if (ended.action) {
      actions.push(ended.action)
      executions.push({ action: ended.action, status: 'applied', result: ended.resultText })
    }
  }

  const decision = makeDecisionRecord({
    state,
    factionId,
    assessment: plan.assessment,
    plannedActions: plan.plannedActions,
    executions,
    publicStatement: plan.pressStatement,
    config,
    modelCalls,
    usage,
    startedAt,
  })
  currentState = appendDecision(currentState, decision)
  return { actions, finalState: currentState, log, pressStatement: plan.pressStatement, decision }
}

function makeDecisionRecord(input: {
  state: GameState
  factionId: FactionId
  assessment: DecisionRecord['assessment']
  plannedActions: Action[]
  executions: DecisionExecution[]
  publicStatement?: string
  config: AgentRuntimeConfig
  modelCalls: number
  usage: ModelUsage
  startedAt: number
}): DecisionRecord {
  return {
    id: nextDecisionId(input.state),
    turn: input.state.turn,
    factionId: input.factionId,
    assessment: input.assessment,
    plannedActions: input.plannedActions,
    executions: input.executions,
    publicStatement: input.publicStatement,
    telemetry: {
      provider: input.config.provider,
      model: input.config.model,
      modelCalls: input.modelCalls,
      latencyMs: Math.max(0, Date.now() - input.startedAt),
      inputTokens: input.usage.inputTokens,
      outputTokens: input.usage.outputTokens,
      cachedInputTokens: input.usage.cachedInputTokens,
      promptVersion: TURN_PLAN_PROMPT_VERSION,
    },
  }
}

function appendDecision(state: GameState, decision: DecisionRecord): GameState {
  return {
    ...state,
    decisions: [decision, ...(state.decisions ?? [])].slice(0, MAX_DECISIONS),
  }
}

function nextDecisionId(state: GameState): string {
  const highest = (state.decisions ?? []).reduce((best, decision) => {
    const match = decision.id.match(/^d(\d+)$/)
    return match ? Math.max(best, Number(match[1])) : best
  }, -1)
  return `d${highest + 1}`
}

function mergeUsage(total: ModelUsage, next: ModelUsage): void {
  if (next.inputTokens != null) total.inputTokens = (total.inputTokens ?? 0) + next.inputTokens
  if (next.outputTokens != null) total.outputTokens = (total.outputTokens ?? 0) + next.outputTokens
  if (next.cachedInputTokens != null) total.cachedInputTokens = (total.cachedInputTokens ?? 0) + next.cachedInputTokens
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
): Promise<{ state: GameState; logEntry?: string; awaitingPlayerResponse?: boolean }> {
  if (action.type === 'propose_ceasefire' || action.type === 'propose_peace') {
    if (state.factions[action.targetId]?.type === 'player') {
      return {
        state,
        awaitingPlayerResponse: true,
        logEntry: `Waiting for ${state.factions[action.targetId].name}'s immediate response`,
      }
    }
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
    if (!sideA || !sideB) return { state }
    if (sideA.type === 'player' || sideB.type === 'player') {
      return {
        state,
        awaitingPlayerResponse: true,
        logEntry: `Waiting for the player's immediate mediation response`,
      }
    }
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
