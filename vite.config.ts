import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Phase 1 is a pure client app (stub AI, no LLM). The local /api/agent route
// for Claude arrives in Phase 3 and will be added as Vite middleware here.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
})
