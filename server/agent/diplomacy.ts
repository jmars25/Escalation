import { respondCeasefire } from '../../src/game/engine.ts'
import type { CeasefireResponse, FactionId, GameState } from '../../src/game/types.ts'
import { summarizeState } from '../summarize.ts'
import { agentRuntimeConfig, createAgentModelAdapter } from './provider.ts'
import type { AgentTool, ModelToolResult } from './types.ts'

const MAX_RESPONSE_STEPS = 3

const CEASEFIRE_TOOLS: AgentTool[] = [
  {
    name: 'respond_ceasefire',
    description: 'Accept or reject the pending peace or ceasefire request. You must choose one.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Pending ceasefire request ID.' },
        response: { type: 'string', enum: ['accepted', 'rejected'] },
        pressStatement: { type: 'string', description: 'Short public press statement explaining the decision.', maxLength: 420 },
        message: { type: 'string', description: 'Deprecated: use pressStatement.', maxLength: 420 },
      },
      required: ['requestId', 'response', 'pressStatement'],
    },
  },
]

export type CeasefireDecision = {
  finalState: GameState
  response: CeasefireResponse
  message: string
  pressStatement: string
}

export async function runCeasefireResponse(state: GameState, requestId: string): Promise<CeasefireDecision> {
  const decision = await runPeaceDecision(state, requestId)
  const request = (state.ceasefireRequests ?? []).find((item) => item.id === requestId)
  if (!request) throw new Error(`Ceasefire request ${requestId} not found`)

  return {
    finalState: respondCeasefire(state, request.to, requestId, decision.response, decision.pressStatement),
    response: decision.response,
    message: decision.pressStatement,
    pressStatement: decision.pressStatement,
  }
}

export async function runPeaceDecision(
  state: GameState,
  requestId: string,
  responderId?: FactionId,
): Promise<Omit<CeasefireDecision, 'finalState'>> {
  const request = (state.ceasefireRequests ?? []).find((item) => item.id === requestId)
  if (!request) throw new Error(`Ceasefire request ${requestId} not found`)

  const config = agentRuntimeConfig()
  if (!config.hasKey) throw new Error(`${config.keyEnv} not set`)

  const actingResponder = responderId ?? request.to
  const responder = state.factions[actingResponder]
  const requester = state.factions[request.from]
  if (!responder || !requester) throw new Error('Ceasefire factions not found')

  const prompt = buildCeasefirePrompt(state, request.from, actingResponder, requestId, request.message)
  logCeasefirePrompt(config.provider, config.model, actingResponder, prompt)
  const adapter = createAgentModelAdapter(config, CEASEFIRE_TOOLS, 'Answer the peace or ceasefire request.')

  for (let step = 0; step < MAX_RESPONSE_STEPS; step++) {
    const toolCalls = await adapter.nextTurn(prompt)
    const toolResults: ModelToolResult[] = []

    for (const call of toolCalls) {
      const response = call.input.response
      const pressStatement = cleanMessage(call.input.pressStatement ?? call.input.message)
      if (call.name !== 'respond_ceasefire' || call.input.requestId !== requestId || (response !== 'accepted' && response !== 'rejected') || !pressStatement) {
        toolResults.push({ id: call.id, content: `Use respond_ceasefire with requestId ${requestId}, response accepted/rejected, and a short pressStatement.`, isError: true })
        continue
      }

      toolResults.push({ id: call.id, content: `Ceasefire ${response}.` })
      adapter.addToolResults(toolResults)
      return { response, message: pressStatement, pressStatement }
    }

    adapter.addToolResults(toolResults)
  }

  const fallbackMessage = 'We cannot accept a ceasefire under the current conditions.'
  return {
    response: 'rejected',
    message: fallbackMessage,
    pressStatement: fallbackMessage,
  }
}

function buildCeasefirePrompt(state: GameState, fromId: FactionId, toId: FactionId, requestId: string, message: string): string {
  const request = (state.ceasefireRequests ?? []).find((item) => item.id === requestId)
  const requester = state.factions[fromId]
  const responder = state.factions[toId]
  const counterpartId = request?.kind === 'mediation'
    ? request.counterpartId === toId ? request.to : request?.counterpartId
    : request?.counterpartId
  const counterpart = counterpartId ? state.factions[counterpartId] : undefined
  const summary = summarizeState(state, toId)
  const requestLabel =
    request?.kind === 'mediation' && counterpart
      ? `a mediated peace proposal from ${requester.name} involving ${counterpart.name}`
      : request?.kind === 'peace_offer'
        ? `a peace offer from ${requester.name}`
        : `a ceasefire request from ${requester.name}`
  const terms = request?.terms?.length
    ? `\nOFFERED TERMS:\n${request.terms.map((term) => `  return (${term.hex.q},${term.hex.r}) from ${state.factions[term.from]?.name ?? term.from} to ${state.factions[term.to]?.name ?? term.to}`).join('\n')}\n`
    : ''
  return `You are ${responder.name} deciding whether to accept ${requestLabel}.

This is not a normal turn. You may only accept or reject this diplomatic request.

Decision question: Given what just happened, would accepting best fulfill your mandate, protect your population and economy, respect red lines, and follow realistic historical precedent? Reject only if the offer is bad faith, rewards aggression, or leaves a critical red-line violation unresolved.

REQUEST ID: ${requestId}
REQUEST FROM ${requester.name}: "${message}"
${terms}

${summary}

Call respond_ceasefire with accepted or rejected and a short pressStatement of no more than 3 sentences.`
}

function cleanMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim().replace(/\s+/g, ' ')
  const sentences = raw.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [raw]
  const trimmed = sentences.slice(0, 3).join(' ').slice(0, 420).trim()
  return trimmed || undefined
}

function logCeasefirePrompt(provider: string, model: string, factionId: FactionId, prompt: string): void {
  console.log(`\n[ceasefire-prompt:start] provider=${provider} model=${model} faction=${factionId}`)
  console.log('--- prompt begin ---')
  console.log(prompt)
  console.log('--- prompt end ---\n')
}
