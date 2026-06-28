import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express'

/**
 * An error with an associated HTTP status. Throw this from a handler (or a guard
 * it calls) to produce a clean client-facing response instead of a 500.
 */
export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
    this.name = 'HttpError'
  }
}

/** Throw a 400 unless `condition` is truthy. Narrows the type like `assert`. */
export function assertValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HttpError(400, message)
}

/**
 * Wrap an async route handler so rejected promises are forwarded to the error
 * middleware instead of crashing the request. Removes per-handler try/catch.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next)
  }
}

/**
 * Terminal error middleware. Maps `HttpError` to its status, logs anything
 * unexpected (or 5xx), and falls back to a 500 with the stringified error.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err)
    return
  }
  if (err instanceof HttpError) {
    if (err.status >= 500) console.error(`[${req.method} ${req.path}]`, err)
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(`[${req.method} ${req.path}]`, err)
  res.status(500).json({ error: String(err) })
}
