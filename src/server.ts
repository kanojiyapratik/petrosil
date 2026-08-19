import { serve } from '@hono/node-server'

import { createGeminiDriver } from './ai/gemini.js'
import { parseSites, parseUsers } from './console/config.js'
import { createConsole } from './console/routes.js'
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
  console: buildConsole(),
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`price module listening on :${info.port}`)
})

/**
 * The admin console, if this deployment is meant to serve one.
 *
 * Off unless CONSOLE_SECRET is set, so an API-only deployment does not
 * accidentally publish a login page. A misconfigured console is a hard
 * failure rather than a half-working one: a signing secret that is absent,
 * or sites and users that will not parse, would otherwise surface as a
 * blank site list nobody could explain.
 */
function buildConsole() {
  const secret = process.env.CONSOLE_SECRET ?? ''

  if (secret === '') {
    return null
  }

  if (secret.length < 32) {
    console.error('CONSOLE_SECRET must be at least 32 characters — refusing to start.')
    process.exit(1)
  }

  try {
    const sites = parseSites(process.env.CONSOLE_SITES)
    const users = parseUsers(process.env.CONSOLE_USERS)

    if (users.length === 0) {
      console.error('CONSOLE_SECRET is set but CONSOLE_USERS is empty — nobody could sign in.')
      process.exit(1)
    }

    console.log(`console enabled: ${users.length} user(s), ${sites.length} site(s)`)

    return createConsole({
      sites,
      users,
      secret,
      // Session cookies are Secure by default. Local runs are plain http,
      // where a Secure cookie is simply never sent back and the login looks
      // broken for no visible reason.
      secureCookies: (process.env.CONSOLE_INSECURE_COOKIES ?? '') !== '1',
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
