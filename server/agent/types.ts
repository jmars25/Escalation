import type { Action } from '../../src/game/engine.ts'
import type { GameState } from '../../src/game/types.ts'

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
}

export type JsonSchemaObject = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
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

export type AgentModelAdapter = {
  nextTurn: (systemPrompt: string) => Promise<ModelToolCall[]>
  addToolResults: (results: ModelToolResult[]) => void
}
