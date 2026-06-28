import { runAgentTurn } from '../agent.ts'
import { runPlayerPublicOpinion } from '../agent/publicOpinion.ts'
import { assertValid, asyncHandler } from '../http.ts'
import { ensureApiKey } from '../guards.ts'
import type { FactionId, GameState } from '../../src/game/types.ts'

/**
 * POST /api/agent-turn — run one faction's full turn through the configured AI provider.
 * Body:    { state, factionId }
 * Returns: { actions, finalState, log }
 */
const agentTurn = asyncHandler(async (req, res) => {
  const { state, factionId } = req.body as { state: GameState; factionId: FactionId }
  assertValid(state && factionId, 'state and factionId required')
  ensureApiKey()
  res.json(await runAgentTurn(state, factionId))
})

/**
 * POST /api/player-public-opinion — private Aurelia-only domestic reaction after the player turn.
 * Body:    { stateBeforeEnd, stateAfterEnd, factionId }
 * Returns: { finalState, article }
 */
const playerPublicOpinion = asyncHandler(async (req, res) => {
  const { stateBeforeEnd, stateAfterEnd, factionId } = req.body as {
    stateBeforeEnd: GameState
    stateAfterEnd: GameState
    factionId: FactionId
  }
  assertValid(
    stateBeforeEnd && stateAfterEnd && factionId,
    'stateBeforeEnd, stateAfterEnd, and factionId required',
  )
  ensureApiKey()
  res.json(await runPlayerPublicOpinion(stateBeforeEnd, stateAfterEnd, factionId))
})

export const agentController = { agentTurn, playerPublicOpinion }
