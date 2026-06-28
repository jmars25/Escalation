import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

vi.mock('../../src/game/engine.ts', () => ({
  proposeCeasefire: vi.fn(),
  proposePeace: vi.fn(),
  mediatePeace: vi.fn(),
  respondCeasefire: vi.fn(),
  respondMediation: vi.fn(),
}))
vi.mock('../agent/diplomacy.ts', () => ({
  runCeasefireResponse: vi.fn(),
  runPeaceDecision: vi.fn(),
}))
vi.mock('../agent.ts', () => ({ agentRuntimeConfig: vi.fn() }))

import { createApp } from '../app.ts'
import { proposeCeasefire, mediatePeace, respondCeasefire, respondMediation } from '../../src/game/engine.ts'
import { runCeasefireResponse, runPeaceDecision } from '../agent/diplomacy.ts'
import { agentRuntimeConfig } from '../agent.ts'

const app = createApp()

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(agentRuntimeConfig).mockReturnValue({
    provider: 'openai', model: 'gpt-test', keyEnv: 'OPENAI_API_KEY', hasKey: true,
  })
})

describe('POST /api/ceasefire-response', () => {
  const body = { state: { turn: 1 }, fromId: 'volkaria', toId: 'aurelia', message: 'truce?' }

  it('proposes, resolves via AI, and echoes the request id', async () => {
    vi.mocked(proposeCeasefire).mockReturnValue({
      ceasefireRequests: [{ id: 'cf1', from: 'volkaria', to: 'aurelia' }],
    } as never)
    vi.mocked(runCeasefireResponse).mockResolvedValue({
      finalState: { turn: 2 }, response: 'accepted', message: 'ok', pressStatement: 'ps',
    } as never)

    const res = await request(app).post('/api/ceasefire-response').send(body)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ requestId: 'cf1', response: 'accepted' })
    expect(runCeasefireResponse).toHaveBeenCalledWith(expect.anything(), 'cf1')
  })

  it('returns 400 when the engine creates no matching request', async () => {
    vi.mocked(proposeCeasefire).mockReturnValue({ ceasefireRequests: [] } as never)

    const res = await request(app).post('/api/ceasefire-response').send(body)

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'ceasefire request could not be created' })
    expect(runCeasefireResponse).not.toHaveBeenCalled()
  })

  it('returns 400 when a required field is missing', async () => {
    const res = await request(app).post('/api/ceasefire-response').send({ state: { turn: 1 }, fromId: 'volkaria' })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'state, fromId, toId, and message required' })
  })

  it('returns 500 when the API key is missing', async () => {
    vi.mocked(agentRuntimeConfig).mockReturnValue({
      provider: 'openai', model: 'gpt-test', keyEnv: 'OPENAI_API_KEY', hasKey: false,
    })

    const res = await request(app).post('/api/ceasefire-response').send(body)

    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'OPENAI_API_KEY not set' })
    expect(proposeCeasefire).not.toHaveBeenCalled()
  })
})

describe('POST /api/mediation-response', () => {
  it('collects both sides and resolves the mediation', async () => {
    vi.mocked(mediatePeace).mockReturnValue({
      ceasefireRequests: [{ id: 'm1', kind: 'mediation', from: 'ostara', to: 'volkaria', counterpartId: 'aurelia' }],
    } as never)
    vi.mocked(runPeaceDecision)
      .mockResolvedValueOnce({ response: 'accepted', message: 'A', pressStatement: 'pa' } as never)
      .mockResolvedValueOnce({ response: 'rejected', message: 'B', pressStatement: 'pb' } as never)
    vi.mocked(respondMediation).mockReturnValue({ turn: 5 } as never)

    const res = await request(app).post('/api/mediation-response').send({
      state: { turn: 1 }, mediatorId: 'ostara', sideAId: 'volkaria', sideBId: 'aurelia', message: 'settle',
    })

    expect(res.status).toBe(200)
    expect(res.body.requestId).toBe('m1')
    expect(res.body.sideA).toMatchObject({ response: 'accepted' })
    expect(res.body.sideB).toMatchObject({ response: 'rejected' })
    expect(res.body.finalState).toEqual({ turn: 5 })
  })
})

describe('POST /api/player-diplomacy-response', () => {
  const state = {
    turn: 1,
    factions: { aurelia: { type: 'player' } },
    ceasefireRequests: [{ id: 'r1', kind: 'ceasefire', to: 'aurelia' }],
  }

  it('resolves a bilateral request without needing an API key', async () => {
    vi.mocked(respondCeasefire).mockReturnValue({ turn: 2 } as never)

    const res = await request(app).post('/api/player-diplomacy-response').send({
      state, requestId: 'r1', responderId: 'aurelia', response: 'accepted', message: 'we agree',
    })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ finalState: { turn: 2 }, player: { response: 'accepted', message: 'we agree' } })
    expect(agentRuntimeConfig).not.toHaveBeenCalled()
  })

  it('returns 400 when the responder is not the player', async () => {
    const res = await request(app).post('/api/player-diplomacy-response').send({
      state, requestId: 'r1', responderId: 'volkaria', response: 'accepted', message: 'hi',
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'player diplomatic request not found' })
  })

  it('returns 400 for an invalid response value', async () => {
    const res = await request(app).post('/api/player-diplomacy-response').send({
      state, requestId: 'r1', responderId: 'aurelia', response: 'maybe', message: 'hi',
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'state, requestId, responderId, response, and message required' })
  })
})
