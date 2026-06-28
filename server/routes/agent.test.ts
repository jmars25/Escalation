import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

vi.mock('../agent.ts', () => ({
  agentRuntimeConfig: vi.fn(),
  runAgentTurn: vi.fn(),
}))
vi.mock('../agent/publicOpinion.ts', () => ({
  runPlayerPublicOpinion: vi.fn(),
}))

import { createApp } from '../app.ts'
import { agentRuntimeConfig, runAgentTurn } from '../agent.ts'
import { runPlayerPublicOpinion } from '../agent/publicOpinion.ts'

const app = createApp()

const withKey = (hasKey: boolean) =>
  vi.mocked(agentRuntimeConfig).mockReturnValue({
    provider: 'openai', model: 'gpt-test', keyEnv: 'OPENAI_API_KEY', hasKey,
  })

beforeEach(() => {
  vi.clearAllMocks()
  withKey(true)
})

describe('POST /api/agent-turn', () => {
  it('runs the turn and returns its result', async () => {
    vi.mocked(runAgentTurn).mockResolvedValue({ actions: [], finalState: { turn: 2 }, log: ['x'] } as never)

    const res = await request(app).post('/api/agent-turn').send({ state: { turn: 1 }, factionId: 'aurelia' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ actions: [], finalState: { turn: 2 }, log: ['x'] })
    expect(runAgentTurn).toHaveBeenCalledWith({ turn: 1 }, 'aurelia')
  })

  it('validates the body before checking the API key', async () => {
    withKey(false)
    const res = await request(app).post('/api/agent-turn').send({ factionId: 'aurelia' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'state and factionId required' })
    expect(runAgentTurn).not.toHaveBeenCalled()
  })

  it('returns 500 when the API key is missing', async () => {
    withKey(false)
    const res = await request(app).post('/api/agent-turn').send({ state: { turn: 1 }, factionId: 'aurelia' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'OPENAI_API_KEY not set' })
    expect(runAgentTurn).not.toHaveBeenCalled()
  })

  it('maps an unexpected service error to 500', async () => {
    vi.mocked(runAgentTurn).mockRejectedValue(new Error('provider exploded'))
    const res = await request(app).post('/api/agent-turn').send({ state: { turn: 1 }, factionId: 'aurelia' })

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'Error: provider exploded' })
  })
})

describe('POST /api/player-public-opinion', () => {
  it('returns the public-opinion result', async () => {
    vi.mocked(runPlayerPublicOpinion).mockResolvedValue({ finalState: { turn: 3 }, article: 'news' } as never)

    const res = await request(app).post('/api/player-public-opinion').send({
      stateBeforeEnd: { turn: 1 }, stateAfterEnd: { turn: 2 }, factionId: 'aurelia',
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ finalState: { turn: 3 }, article: 'news' })
  })

  it('rejects a body missing stateAfterEnd with 400', async () => {
    const res = await request(app).post('/api/player-public-opinion').send({
      stateBeforeEnd: { turn: 1 }, factionId: 'aurelia',
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'stateBeforeEnd, stateAfterEnd, and factionId required' })
  })
})
