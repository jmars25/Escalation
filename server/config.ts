import type { CorsOptions } from 'cors'

/** Runtime configuration for the HTTP server, sourced from the environment. */
export const config = {
  port: Number(process.env.PORT ?? 3001),
  jsonBodyLimit: '2mb',
  // Allow any localhost origin (any port) so the Vite dev server can call the API.
  cors: { origin: /^http:\/\/localhost(:\d+)?$/ } satisfies CorsOptions,
}
