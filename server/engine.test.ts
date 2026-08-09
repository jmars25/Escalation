import { describe, expect, it } from 'vitest'
import { availableActions, sendAidPackage } from '../src/game/engine.ts'
import { buildInitialState } from '../src/game/scenario.ts'

describe('aid action budget', () => {
  it('allows at most one aid package per faction per round', () => {
    const state = buildInitialState()
    const senderId = state.order[state.turnIndex]
    const sender = state.factions[senderId]
    const ally = Object.values(state.factions).find((faction) =>
      faction.id !== senderId && faction.alignment === sender.alignment,
    )
    expect(ally).toBeDefined()

    const afterFirst = sendAidPackage(state, senderId, ally!.id, 'economic')
    const afterSecond = sendAidPackage(afterFirst, senderId, ally!.id, 'arms')

    expect(afterFirst).not.toBe(state)
    expect(afterFirst.aidSentTurn?.[senderId]).toBe(state.turn)
    expect(afterSecond).toBe(afterFirst)
    expect(availableActions(afterFirst).some((action) => action.type === 'send_aid')).toBe(false)

    const nextRound = { ...afterFirst, turn: afterFirst.turn + 1 }
    const afterNextRoundAid = sendAidPackage(nextRound, senderId, ally!.id, 'arms')
    expect(afterNextRoundAid).not.toBe(nextRound)
    expect(afterNextRoundAid.aidSentTurn?.[senderId]).toBe(nextRound.turn)
  })
})
