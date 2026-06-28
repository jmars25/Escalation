import express, { type Express } from 'express'
import cors from 'cors'
import { config } from './config.ts'
import { apiRouter } from './routes/index.ts'
import { errorHandler } from './http.ts'

/**
 * Build the Express application: middleware, routes, and the terminal error
 * handler. Kept separate from `listen` so tests can exercise it without a port.
 */
export function createApp(): Express {
  const app = express()

  app.use(cors(config.cors))
  app.use(express.json({ limit: config.jsonBodyLimit }))

  app.use('/api', apiRouter)

  app.use(errorHandler)

  return app
}
