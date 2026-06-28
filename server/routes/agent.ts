import { Router } from 'express'
import { agentController } from '../controllers/agent.controller.ts'

export const agentRouter = Router()

agentRouter.post('/agent-turn', agentController.agentTurn)
agentRouter.post('/player-public-opinion', agentController.playerPublicOpinion)
