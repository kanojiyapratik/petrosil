import { serve } from '@hono/node-server'

import { createGeminiDriver } from './ai/gemini.js'
import { createApp } from './http/app.js'

const apiToken = process.env.PRICE_API_TOKEN ?? ''
const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ''
const port = Number(process.env.PORT ?? 8094)

// Fail loudly at boot rather than 401/500ing every request later. The auth
// middleware also fails closed, but a service started without its token is a
// misconfiguration, not a runtime condition worth serving through.
if (apiToken === '') {
  console.error('PRICE_API_TOKEN is not set — refusing to start.')
  process.exit(1)
}

if (apiKey === '') {
  console.error('GOOGLE_GENERATIVE_AI_API_KEY is not set — refusing to start.')
  process.exit(1)
}

const app = createApp({
  apiToken,
  driver: createGeminiDriver({ apiKey }),
  defaultModel: process.env.AI_DEFAULT_MODEL ?? 'gemini-2.5-flash',
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`price module listening on :${info.port}`)
})
