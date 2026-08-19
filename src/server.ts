import { serve } from '@hono/node-server'

import { createGeminiDriver } from './ai/gemini.js'
import { parseSites, parseUsers } from './console/config.js'
import { createConsole } from './console/routes.js'
import { migrate } from './db/migrate.js'
import { createPool } from './db/pool.js'
import { createStore, seed } from './db/store.js'
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
  console: await buildConsole(),
})

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`price module listening on :${info.port}`)
})

/**
 * The admin console, if this deployment is meant to serve one.
 *
 * Off unless DATABASE_URL and CONSOLE_SECRET are both set, so an API-only
 * deployment publishes no login page. Misconfiguration is a hard failure
 * rather than a half-working console: a database it cannot reach, or a
 * signing secret it does not have, would otherwise surface as a blank site
 * list nobody could explain.
 */
async function buildConsole() {
  const databaseUrl = process.env.DATABASE_URL ?? ''
  const secret = process.env.CONSOLE_SECRET ?? ''

  if (databaseUrl === '' && secret === '') {
    return null
  }

  if (databaseUrl === '' || secret === '') {
    console.error('The console needs both DATABASE_URL and CONSOLE_SECRET — refusing to start.')
    process.exit(1)
  }

  if (secret.length < 32) {
    console.error('CONSOLE_SECRET must be at least 32 characters — refusing to start.')
    process.exit(1)
  }

  try {
    const pool = createPool(databaseUrl)
    // Migrations run here because the production database is Railway's,
    // reachable only from inside their network: a deploy is the only thing
    // that can migrate it, so the deploy does.
    const ran = await migrate(pool)

    if (ran.length > 0) {
      console.log(`applied ${ran.length} migration(s): ${ran.join(', ')}`)
    }

    const store = createStore(pool)

    // CONSOLE_SITES / CONSOLE_USERS were how this was configured before the
    // database existed. They still seed a fresh install, and never overwrite
    // anything edited through the screens.
    const seeded = await seed(store, parseUsers(process.env.CONSOLE_USERS), parseSites(process.env.CONSOLE_SITES))

    if (seeded.users > 0 || seeded.sites > 0) {
      console.log(`seeded ${seeded.users} user(s) and ${seeded.sites} site(s) from the environment`)
    }

    const users = await store.users()

    if (users.length === 0) {
      console.error(
        'The console has no users. Seed one with CONSOLE_USERS (see .env.example) — otherwise nobody can sign in.',
      )
      process.exit(1)
    }

    console.log(`console enabled: ${users.length} user(s), ${(await store.sites()).length} site(s)`)

    return createConsole({
      store,
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
