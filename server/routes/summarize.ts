import { Router } from 'express'
import { summarizeController } from '../controllers/summarize.controller.ts'

export const summarizeRouter = Router()

summarizeRouter.post('/summarize', summarizeController.summarize)
