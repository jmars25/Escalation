import { mediatePeace, proposeCeasefire, proposePeace, respondCeasefire, respondMediation } from '../../src/game/engine.ts'
import { runCeasefireResponse, runPeaceDecision } from '../agent/diplomacy.ts'
import { assertValid, asyncHandler, HttpError } from '../http.ts'
import { ensureApiKey } from '../guards.ts'
import type { FactionId, GameState, Hex } from '../../src/game/types.ts'

const asHexes = (value: unknown): Hex[] => (Array.isArray(value) ? value : [])

/**
 * POST /api/ceasefire-response — ask an AI faction to answer a ceasefire request.
 * Body:    { state, fromId, toId, message, returnHexes?, restoreHexes? }
 * Returns: { finalState, requestId, response, message, pressStatement }
 */
const ceasefireResponse = asyncHandler(async (req, res) => {
  const { state, fromId, toId, message, returnHexes, restoreHexes } = req.body as {
    state: GameState
    fromId: FactionId
    toId: FactionId
    message: string
    returnHexes?: Hex[]
    restoreHexes?: Hex[]
  }
  assertValid(state && fromId && toId && typeof message === 'string', 'state, fromId, toId, and message required')
  ensureApiKey()

  const proposed = proposeCeasefire(state, fromId, toId, message, asHexes(returnHexes), asHexes(restoreHexes))
  const request = (proposed.ceasefireRequests ?? []).find((item) => item.from === fromId && item.to === toId)
  if (!request) throw new HttpError(400, 'ceasefire request could not be created')

  const result = await runCeasefireResponse(proposed, request.id)
  res.json({ ...result, requestId: request.id })
})

/**
 * POST /api/peace-response — ask an AI faction to answer a peace offer with terms.
 * Body:    { state, fromId, toId, message, returnHexes?, restoreHexes? }
 * Returns: { finalState, requestId, response, message, pressStatement }
 */
const peaceResponse = asyncHandler(async (req, res) => {
  const { state, fromId, toId, message, returnHexes, restoreHexes } = req.body as {
    state: GameState
    fromId: FactionId
    toId: FactionId
    message: string
    returnHexes?: Hex[]
    restoreHexes?: Hex[]
  }
  assertValid(state && fromId && toId && typeof message === 'string', 'state, fromId, toId, and message required')
  ensureApiKey()

  const proposed = proposePeace(state, fromId, toId, message, asHexes(returnHexes), asHexes(restoreHexes))
  const request = (proposed.ceasefireRequests ?? []).find((item) =>
    item.kind === 'peace_offer' && item.from === fromId && item.to === toId,
  )
  if (!request) throw new HttpError(400, 'peace request could not be created')

  const result = await runCeasefireResponse(proposed, request.id)
  res.json({ ...result, requestId: request.id })
})

/**
 * POST /api/mediation-response — ask both AI factions to answer a mediated peace proposal.
 * Body:    { state, mediatorId, sideAId, sideBId, message, returnHexes?, restoreHexes? }
 * Returns: { finalState, requestId, sideA, sideB }
 */
const mediationResponse = asyncHandler(async (req, res) => {
  const { state, mediatorId, sideAId, sideBId, message, returnHexes, restoreHexes } = req.body as {
    state: GameState
    mediatorId: FactionId
    sideAId: FactionId
    sideBId: FactionId
    message: string
    returnHexes?: Hex[]
    restoreHexes?: Hex[]
  }
  assertValid(
    state && mediatorId && sideAId && sideBId && typeof message === 'string',
    'state, mediatorId, sideAId, sideBId, and message required',
  )
  ensureApiKey()

  const proposed = mediatePeace(state, mediatorId, sideAId, sideBId, message, asHexes(returnHexes), asHexes(restoreHexes))
  const request = (proposed.ceasefireRequests ?? []).find((item) =>
    item.kind === 'mediation' &&
    item.from === mediatorId &&
    item.to === sideAId &&
    item.counterpartId === sideBId,
  )
  if (!request) throw new HttpError(400, 'mediation request could not be created')

  // The mediator auto-accepts its own proposal; the other parties decide via the AI.
  const accepted = { response: 'accepted' as const, message, pressStatement: message }
  const sideA = sideAId === mediatorId ? accepted : await runPeaceDecision(proposed, request.id, sideAId)
  const sideB = sideBId === mediatorId ? accepted : await runPeaceDecision(proposed, request.id, sideBId)
  const finalState = respondMediation(
    proposed, request.id, sideA.response, sideA.pressStatement, sideB.response, sideB.pressStatement,
  )
  res.json({ finalState, requestId: request.id, sideA, sideB })
})

/**
 * POST /api/player-diplomacy-response — resolve an out-of-turn request addressed to the player.
 * Bilateral requests already contain the proposer's consent. Mediation still requires both sides.
 */
const playerDiplomacyResponse = asyncHandler(async (req, res) => {
  const { state, requestId, responderId, response, message } = req.body as {
    state: GameState
    requestId: string
    responderId: FactionId
    response: 'accepted' | 'rejected'
    message: string
  }
  assertValid(
    state && requestId && responderId &&
    (response === 'accepted' || response === 'rejected') &&
    typeof message === 'string',
    'state, requestId, responderId, response, and message required',
  )

  const request = (state.ceasefireRequests ?? []).find((item) => item.id === requestId)
  const responder = state.factions[responderId]
  if (!request || responder?.type !== 'player') throw new HttpError(400, 'player diplomatic request not found')

  // Bilateral request: the player simply accepts or rejects.
  if (request.kind !== 'mediation') {
    if (request.to !== responderId) throw new HttpError(400, 'request is not addressed to this player')
    const finalState = respondCeasefire(state, responderId, requestId, response, message)
    res.json({ finalState, player: { response, message } })
    return
  }

  // Mediation: the player is one side; the AI decides for the other.
  const sideAId = request.to
  const sideBId = request.counterpartId
  if (!sideBId || (sideAId !== responderId && sideBId !== responderId)) {
    throw new HttpError(400, 'player is not a party to this mediation')
  }
  const otherId = sideAId === responderId ? sideBId : sideAId
  if (!state.factions[otherId]) throw new HttpError(400, 'other mediation party not found')

  ensureApiKey()
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
})

export const diplomacyController = {
  ceasefireResponse,
  peaceResponse,
  mediationResponse,
  playerDiplomacyResponse,
}
