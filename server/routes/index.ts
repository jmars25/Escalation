import { Router } from 'express'
import { summarizeRouter } from './summarize.ts'
import { agentRouter } from './agent.ts'
import { diplomacyRouter } from './diplomacy.ts'

/** All API routes, mounted under `/api` by the app. */
export const apiRouter = Router()

apiRouter.use(summarizeRouter)
apiRouter.use(agentRouter)
apiRouter.use(diplomacyRouter)
