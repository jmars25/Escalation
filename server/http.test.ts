import { describe, it, expect, vi } from 'vitest'
import { HttpError, assertValid, asyncHandler } from './http.ts'

describe('HttpError', () => {
  it('carries a status and message', () => {
    const err = new HttpError(404, 'nope')
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(404)
    expect(err.message).toBe('nope')
  })
})

describe('assertValid', () => {
  it('passes through when the condition is truthy', () => {
    expect(() => assertValid(1, 'should not throw')).not.toThrow()
  })

  it('throws a 400 HttpError when the condition is falsy', () => {
    expect(() => assertValid(0, 'bad input')).toThrow(HttpError)
    try {
      assertValid('', 'bad input')
    } catch (err) {
      expect((err as HttpError).status).toBe(400)
      expect((err as HttpError).message).toBe('bad input')
    }
  })
})

describe('asyncHandler', () => {
  it('forwards a rejected promise to next()', async () => {
    const next = vi.fn()
    const boom = new Error('boom')
    await asyncHandler(async () => { throw boom })({} as never, {} as never, next)
    // Let the rejection microtask settle.
    await Promise.resolve()
    expect(next).toHaveBeenCalledWith(boom)
  })

  it('does not call next() when the handler resolves', async () => {
    const next = vi.fn()
    await asyncHandler(async () => undefined)({} as never, {} as never, next)
    await Promise.resolve()
    expect(next).not.toHaveBeenCalled()
  })
})
