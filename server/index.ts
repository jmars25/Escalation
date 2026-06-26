import express from 'express'
import cors from 'cors'
import { summarizeState } from './summarize.ts'
import { agentRuntimeConfig, runAgentTurn } from './agent.ts'
import { mediatePeace, proposeCeasefire, proposePeace, respondCeasefire, respondMediation } from '../src/game/engine.ts'
import { runCeasefireResponse, runPeaceDecision } from './agent/diplomacy.ts'
import type { GameState, FactionId, Hex } from '../src/game/types.ts'
import { runPlayerPublicOpinion } from './agent/publicOpinion.ts'

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

/** POST /api/player-public-opinion - private Aurelia-only domestic reaction after the player turn.
 *  Body:    { stateBeforeEnd, stateAfterEnd, factionId }
 *  Returns: { finalState, article }
 */
app.post('/api/player-public-opinion', async (req, res) => {
  const { stateBeforeEnd, stateAfterEnd, factionId } = req.body as {
    stateBeforeEnd: GameState
    stateAfterEnd: GameState
    factionId: FactionId
  }
  if (!stateBeforeEnd || !stateAfterEnd || !factionId) {
    res.status(400).json({ error: 'stateBeforeEnd, stateAfterEnd, and factionId required' })
    return
  }
  const config = agentRuntimeConfig()
  if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
  try {
    const result = await runPlayerPublicOpinion(stateBeforeEnd, stateAfterEnd, factionId)
    res.json(result)
  } catch (err) {
    console.error('[player-public-opinion]', err)
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

/** POST /api/peace-response - ask an AI faction to answer a peace offer with terms
 *  Body:    { state, fromId, toId, message, returnHexes }
 *  Returns: { finalState, requestId, response, message, pressStatement }
 */
app.post('/api/peace-response', async (req, res) => {
  const { state, fromId, toId, message, returnHexes } = req.body as {
    state: GameState
    fromId: FactionId
    toId: FactionId
    message: string
    returnHexes?: Hex[]
  }
  if (!state || !fromId || !toId || typeof message !== 'string') {
    res.status(400).json({ error: 'state, fromId, toId, and message required' })
    return
  }
  const config = agentRuntimeConfig()
  if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
  try {
    const proposed = proposePeace(state, fromId, toId, message, Array.isArray(returnHexes) ? returnHexes : [])
    const request = (proposed.ceasefireRequests ?? []).find((item) =>
      item.kind === 'peace_offer' &&
      item.from === fromId &&
      item.to === toId,
    )
    if (!request) { res.status(400).json({ error: 'peace request could not be created' }); return }
    const result = await runCeasefireResponse(proposed, request.id)
    res.json({ ...result, requestId: request.id })
  } catch (err) {
    console.error('[peace-response]', err)
    res.status(500).json({ error: String(err) })
  }
})

/** POST /api/mediation-response - ask both AI factions to answer a mediated peace proposal
 *  Body:    { state, mediatorId, sideAId, sideBId, message, returnHexes }
 *  Returns: { finalState, requestId, sideA, sideB }
 */
app.post('/api/mediation-response', async (req, res) => {
  const { state, mediatorId, sideAId, sideBId, message, returnHexes } = req.body as {
    state: GameState
    mediatorId: FactionId
    sideAId: FactionId
    sideBId: FactionId
    message: string
    returnHexes?: Hex[]
  }
  if (!state || !mediatorId || !sideAId || !sideBId || typeof message !== 'string') {
    res.status(400).json({ error: 'state, mediatorId, sideAId, sideBId, and message required' })
    return
  }
  const config = agentRuntimeConfig()
  if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
  try {
    const proposed = mediatePeace(state, mediatorId, sideAId, sideBId, message, Array.isArray(returnHexes) ? returnHexes : [])
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

/** POST /api/player-diplomacy-response - resolve an out-of-turn request addressed to the player.
 *  Bilateral requests already contain the proposer's consent. Mediation still requires both sides.
 */
app.post('/api/player-diplomacy-response', async (req, res) => {
  const { state, requestId, responderId, response, message } = req.body as {
    state: GameState
    requestId: string
    responderId: FactionId
    response: 'accepted' | 'rejected'
    message: string
  }
  if (!state || !requestId || !responderId || (response !== 'accepted' && response !== 'rejected') || typeof message !== 'string') {
    res.status(400).json({ error: 'state, requestId, responderId, response, and message required' })
    return
  }
  const request = (state.ceasefireRequests ?? []).find((item) => item.id === requestId)
  const responder = state.factions[responderId]
  if (!request || responder?.type !== 'player') {
    res.status(400).json({ error: 'player diplomatic request not found' })
    return
  }

  try {
    if (request.kind !== 'mediation') {
      if (request.to !== responderId) {
        res.status(400).json({ error: 'request is not addressed to this player' })
        return
      }
      const finalState = respondCeasefire(state, responderId, requestId, response, message)
      res.json({ finalState, player: { response, message } })
      return
    }

    const sideAId = request.to
    const sideBId = request.counterpartId
    if (!sideBId || (sideAId !== responderId && sideBId !== responderId)) {
      res.status(400).json({ error: 'player is not a party to this mediation' })
      return
    }
    const otherId = sideAId === responderId ? sideBId : sideAId
    const other = state.factions[otherId]
    if (!other) {
      res.status(400).json({ error: 'other mediation party not found' })
      return
    }
    const config = agentRuntimeConfig()
    if (!config.hasKey) { res.status(500).json({ error: `${config.keyEnv} not set` }); return }
    const otherDecision = await runPeaceDecision(state, requestId, otherId)
    const playerMessage = message.trim() || (response === 'accepted'
      ? 'We accept the mediated peace proposal.'
      : 'We reject the mediated peace proposal under the current conditions.')
    const finalState = sideAId === responderId
      ? respondMediation(state, requestId, response, playerMessage, otherDecision.response, otherDecision.pressStatement)
      : respondMediation(state, requestId, otherDecision.response, otherDecision.pressStatement, response, playerMessage)
    res.json({
      finalState,
      player: { response, message: playerMessage },
      other: { factionId: otherId, ...otherDecision },
    })
  } catch (err) {
    console.error('[player-diplomacy-response]', err)
    res.status(500).json({ error: String(err) })
  }
})

app.listen(PORT, () => {
  const config = agentRuntimeConfig()
  console.log(`Escalation API  http://localhost:${PORT}`)
  console.log(`AI provider:    ${config.provider} (${config.model})`)
  console.log(`API key:        ${config.hasKey ? 'set' : `MISSING - set ${config.keyEnv}`}`)
})
