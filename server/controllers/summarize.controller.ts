import type { RequestHandler } from 'express'
import { summarizeState } from '../summarize.ts'
import { assertValid } from '../http.ts'
import type { FactionId, GameState } from '../../src/game/types.ts'

/** POST /api/summarize — debug endpoint, returns the text prompt for a faction. */
const summarize: RequestHandler = (req, res) => {
  const { state, factionId } = req.body as { state: GameState; factionId: FactionId }
  assertValid(state && factionId, 'state and factionId required')
  res.json({ summary: summarizeState(state, factionId) })
}

export const summarizeController = { summarize }
