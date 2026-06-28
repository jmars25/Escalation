import { agentRuntimeConfig } from './agent.ts'
import { HttpError } from './http.ts'

/**
 * Ensure the configured AI provider has an API key. Throws a 500 naming the
 * missing env var, matching the original behaviour. Call this inside a handler
 * (after body validation) so the validation error still takes precedence.
 */
export function ensureApiKey(): void {
  const config = agentRuntimeConfig()
  if (!config.hasKey) throw new HttpError(500, `${config.keyEnv} not set`)
}
