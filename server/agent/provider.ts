import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { AGENT_TOOLS } from './factionAgent.ts'
import type { AgentModelAdapter, AgentProvider, AgentRuntimeConfig, AgentTool, ModelToolCall, ModelToolResult } from './types.ts'

const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001'
const DEFAULT_OPENAI_MODEL = 'gpt-5.4-mini'

let anthropicClient: Anthropic | null = null
let openAiClient: OpenAI | null = null

function selectedProvider(): AgentProvider {
  const raw = (process.env.AI_PROVIDER ?? 'openai').trim().toLowerCase()
  if (raw === 'anthropic' || raw === 'openai') return raw
  throw new Error(`Unsupported AI_PROVIDER "${raw}". Use "openai" or "anthropic".`)
}

export function agentRuntimeConfig(): AgentRuntimeConfig {
  const provider = selectedProvider()
  const keyEnv = provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'
  const model = provider === 'openai'
    ? (process.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL)
    : (process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL)

  return {
    provider,
    keyEnv,
    model,
    hasKey: Boolean(process.env[keyEnv]?.trim()),
  }
}

export function createAgentModelAdapter(config: AgentRuntimeConfig, tools: AgentTool[] = AGENT_TOOLS, initialUserMessage = 'Take your turn.'): AgentModelAdapter {
  return config.provider === 'openai'
    ? createOpenAiAdapter(config.model, tools, initialUserMessage)
    : createAnthropicAdapter(config.model, tools, initialUserMessage)
}

function getAnthropicClient(): Anthropic {
  anthropicClient ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return anthropicClient
}

function getOpenAiClient(): OpenAI {
  openAiClient ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  return openAiClient
}

function createAnthropicAdapter(model: string, tools: AgentTool[], initialUserMessage: string): AgentModelAdapter {
  const client = getAnthropicClient()
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: initialUserMessage },
  ]
  const anthropicTools: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }))

  return {
    async nextTurn(systemPrompt) {
      const response = await client.messages.create({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      })

      messages.push({ role: 'assistant', content: response.content })

      return response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((call): ModelToolCall => ({
          id: call.id,
          name: call.name,
          input: call.input as Record<string, unknown>,
        }))
    },
    addToolResults(results) {
      if (results.length === 0) return
      messages.push({
        role: 'user',
        content: results.map((result): Anthropic.ToolResultBlockParam => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          is_error: result.isError,
        })),
      })
    },
  }
}

function createOpenAiAdapter(model: string, tools: AgentTool[], initialUserMessage: string): AgentModelAdapter {
  const client = getOpenAiClient()
  const conversation: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'user', content: initialUserMessage },
  ]
  const openAiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }))

  return {
    async nextTurn(systemPrompt) {
      const response = await client.chat.completions.create({
        model,
        max_completion_tokens: 1024,
        messages: [
          { role: 'system', content: systemPrompt },
          ...conversation,
        ],
        tools: openAiTools,
        tool_choice: 'auto',
      })

      const message = response.choices[0]?.message
      if (!message) return []

      conversation.push(message)

      return (message.tool_calls ?? []).map((call): ModelToolCall => {
        if (call.type !== 'function') {
          return {
            id: call.id,
            name: 'unsupported_tool_call',
            input: {},
            unsupportedType: call.type,
          }
        }

        return {
          id: call.id,
          name: call.function.name,
          input: parseJsonObject(call.function.arguments),
        }
      })
    },
    addToolResults(results) {
      for (const result of results) {
        conversation.push({ role: 'tool', tool_call_id: result.id, content: result.content })
      }
    },
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}
