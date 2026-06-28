import { createApp } from './app.ts'
import { config } from './config.ts'
import { agentRuntimeConfig } from './agent.ts'

const app = createApp()

app.listen(config.port, () => {
  const runtime = agentRuntimeConfig()
  console.log(`Escalation API  http://localhost:${config.port}`)
  console.log(`AI provider:    ${runtime.provider} (${runtime.model})`)
  console.log(`API key:        ${runtime.hasKey ? 'set' : `MISSING - set ${runtime.keyEnv}`}`)
})
