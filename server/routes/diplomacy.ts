import { Router } from 'express'
import { diplomacyController } from '../controllers/diplomacy.controller.ts'

export const diplomacyRouter = Router()

diplomacyRouter.post('/ceasefire-response', diplomacyController.ceasefireResponse)
diplomacyRouter.post('/peace-response', diplomacyController.peaceResponse)
diplomacyRouter.post('/mediation-response', diplomacyController.mediationResponse)
diplomacyRouter.post('/player-diplomacy-response', diplomacyController.playerDiplomacyResponse)
