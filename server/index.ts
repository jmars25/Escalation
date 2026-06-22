import express from 'express'
import cors from 'cors'
import { summarizeState } from './summarize.ts'
import { agentRuntimeConfig, runAgentTurn } from './agent.ts'
import { mediatePeace, proposeCeasefire, respondMediation } from '../src/game/engine.ts'
import { runCeasefireResponse, runPeaceDecision } from './agent/diplomacy.ts'
import type { GameState, FactionId } from '../src/game/types.ts'

const app = express()
const PORT = 3001

app.use(cors({ origin: /^http:\/\/localhost(:\d+)?$/ }))
app.use(express.json({ limit: '2mb' }))

/** POST /api/summarize — debug endpoint, returns the text prompt for a faction */
app.post('/api/summarize', (req, res) => {
  const { state, factionId } = req.body as { state: GameState; factionId: FactionId }
  if (!state || !factionId) { res.status(400).json({ error: 'state and factionId required' }); return }
  res.json({ summary: summarizeState(state, factionId) })
})

/** POST /api/agent-turn - run one faction's full turn through the configured AI provider
 *  Body:    { state: GameState, factionId: FactionId }
 *  Returns: { actions: Action[], finalState: GameState, log: string[] }
 */
app.post('/api/agent-turn', async (req, res) => {
  const { state, factionId } = req.body as { state: GameState; factionId: FactionId }
  if (!state || !factionId) { res.status(400).json({ error: 'state and factionId required' }); return }
  const config = agentRuntimeConfig()
  if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
  try {
    const result = await runAgentTurn(state, factionId)
    res.json(result)
  } catch (err) {
    console.error('[agent-turn]', err)
    res.status(500).json({ error: String(err) })
  }
})

/** POST /api/ceasefire-response - ask an AI faction to answer a ceasefire request
 *  Body:    { state, fromId, toId, message }
 *  Returns: { finalState, requestId, response, message, pressStatement }
 */
app.post('/api/ceasefire-response', async (req, res) => {
  const { state, fromId, toId, message } = req.body as { state: GameState; fromId: FactionId; toId: FactionId; message: string }
  if (!state || !fromId || !toId || typeof message !== 'string') {
    res.status(400).json({ error: 'state, fromId, toId, and message required' })
    return
  }
  const config = agentRuntimeConfig()
  if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
  try {
    const proposed = proposeCeasefire(state, fromId, toId, message)
    const request = (proposed.ceasefireRequests ?? []).find((item) => item.from === fromId && item.to === toId)
    if (!request) { res.status(400).json({ error: 'ceasefire request could not be created' }); return }
    const result = await runCeasefireResponse(proposed, request.id)
    res.json({ ...result, requestId: request.id })
  } catch (err) {
    console.error('[ceasefire-response]', err)
    res.status(500).json({ error: String(err) })
  }
})

/** POST /api/mediation-response - ask both AI factions to answer a mediated peace proposal
 *  Body:    { state, mediatorId, sideAId, sideBId, message }
 *  Returns: { finalState, requestId, sideA, sideB }
 */
app.post('/api/mediation-response', async (req, res) => {
  const { state, mediatorId, sideAId, sideBId, message } = req.body as {
    state: GameState
    mediatorId: FactionId
    sideAId: FactionId
    sideBId: FactionId
    message: string
  }
  if (!state || !mediatorId || !sideAId || !sideBId || typeof message !== 'string') {
    res.status(400).json({ error: 'state, mediatorId, sideAId, sideBId, and message required' })
    return
  }
  const config = agentRuntimeConfig()
  if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
  try {
    const proposed = mediatePeace(state, mediatorId, sideAId, sideBId, message)
    const request = (proposed.ceasefireRequests ?? []).find((item) =>
      item.kind === 'mediation' &&
      item.from === mediatorId &&
      item.to === sideAId &&
      item.counterpartId === sideBId,
    )
    if (!request) { res.status(400).json({ error: 'mediation request could not be created' }); return }

    const sideA = sideAId === mediatorId
      ? { response: 'accepted' as const, message: message, pressStatement: message }
      : await runPeaceDecision(proposed, request.id, sideAId)
    const sideB = sideBId === mediatorId
      ? { response: 'accepted' as const, message: message, pressStatement: message }
      : await runPeaceDecision(proposed, request.id, sideBId)
    const finalState = respondMediation(
      proposed,
      request.id,
      sideA.response,
      sideA.pressStatement,
      sideB.response,
      sideB.pressStatement,
    )
    res.json({ finalState, requestId: request.id, sideA, sideB })
  } catch (err) {
    console.error('[mediation-response]', err)
    res.status(500).json({ error: String(err) })
  }
})

app.listen(PORT, () => {
  const config = agentRuntimeConfig()
  console.log(`Escalation API  http://localhost:${PORT}`)
  console.log(`AI provider:    ${config.provider} (${config.model})`)
  console.log(`API key:        ${config.hasKey ? 'set' : `MISSING - set ${config.keyEnv}`}`)
})
