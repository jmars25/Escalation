import type { Action } from '../../src/game/engine.ts'
import type { DecisionRecord, GameState } from '../../src/game/types.ts'

export type AgentProvider = 'anthropic' | 'openai'

export type AgentRuntimeConfig = {
  provider: AgentProvider
  keyEnv: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'
  model: string
  hasKey: boolean
}

export type AgentResult = {
  actions: Action[]
  finalState: GameState
  log: string[]
  pressStatement?: string
  decision?: DecisionRecord
}

export type JsonSchemaObject = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type AgentTool = {
  name: string
  description: string
  input_schema: JsonSchemaObject
}

export type ModelToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
  unsupportedType?: string
}

export type ModelToolResult = {
  id: string
  content: string
  isError?: boolean
}

export type ModelUsage = {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
}

export type ModelTurnResult = {
  toolCalls: ModelToolCall[]
  usage: ModelUsage
}

export type AgentModelAdapter = {
  nextTurn: (systemPrompt: string) => Promise<ModelTurnResult>
  addToolResults: (results: ModelToolResult[]) => void
}
