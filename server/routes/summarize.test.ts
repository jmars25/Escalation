import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'

vi.mock('../summarize.ts', () => ({ summarizeState: vi.fn(() => 'PROMPT TEXT') }))

import { createApp } from '../app.ts'
import { summarizeState } from '../summarize.ts'

const app = createApp()

describe('POST /api/summarize', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the summary for a valid body', async () => {
    const res = await request(app)
      .post('/api/summarize')
      .send({ state: { turn: 1 }, factionId: 'aurelia' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ summary: 'PROMPT TEXT' })
    expect(summarizeState).toHaveBeenCalledWith({ turn: 1 }, 'aurelia')
  })

  it('rejects a body missing factionId with 400', async () => {
    const res = await request(app).post('/api/summarize').send({ state: { turn: 1 } })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'state and factionId required' })
    expect(summarizeState).not.toHaveBeenCalled()
  })
})
