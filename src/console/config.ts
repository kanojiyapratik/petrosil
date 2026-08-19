/**
 * Who can sign in to the console, and which sites it can drive.
 *
 * Both come from the environment rather than a database. The module has no
 * database by design -- the price data lives on the sites and the crawler
 * state lives with it -- and adding one to hold two users and three site rows
 * would be the tail wagging the dog. When the list outgrows an env var, this
 * is the one file that has to change.
 */

export interface ConsoleSite {
  /** Stable slug used in URLs: /sites/baseoil/crawler */
  id: string
  name: string
  /** e.g. https://baseoilreport.com/api */
  apiUrl: string
  /** That site's own `users.api_token`. */
  token: string
}

export interface ConsoleUser {
  email: string
  name: string
  /** scrypt, as `scrypt:<saltHex>:<hashHex>`. Never a plain password. */
  passwordHash: string
}

export class ConsoleConfigError extends Error {
  override readonly name = 'ConsoleConfigError'
}

/**
 * `CONSOLE_SITES` is a JSON array:
 *   [{"id":"baseoil","name":"Base Oil Report",
 *     "apiUrl":"https://baseoilreport.com/api","token":"..."}]
 */
export function parseSites(raw: string | undefined): ConsoleSite[] {
  const entries = parseJsonArray(raw, 'CONSOLE_SITES')

  return entries.map((entry, at) => {
    const site = entry as Partial<ConsoleSite>
    const where = `CONSOLE_SITES[${at}]`

    const id = requireString(site.id, `${where}.id`)
    const apiUrl = requireString(site.apiUrl, `${where}.apiUrl`)

    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new ConsoleConfigError(
        `${where}.id must be a slug (lowercase letters, digits, dashes): got "${id}"`,
      )
    }

    // The console builds request URLs from this; anything but http(s) would
    // send a site token somewhere it does not belong.
    let parsed: URL

    try {
      parsed = new URL(apiUrl)
    } catch {
      throw new ConsoleConfigError(`${where}.apiUrl is not a URL: ${apiUrl}`)
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConsoleConfigError(`${where}.apiUrl must be http or https: ${apiUrl}`)
    }

    return {
      id,
      name: typeof site.name === 'string' && site.name.trim() !== '' ? site.name : id,
      apiUrl: apiUrl.replace(/\/+$/, ''),
      token: requireString(site.token, `${where}.token`),
    }
  })
}

/**
 * `CONSOLE_USERS` is a JSON array:
 *   [{"email":"rakesh@tikitech.in","name":"Rakesh","passwordHash":"scrypt:..."}]
 *
 * Emails are lowercased so sign-in is not case-sensitive, which is how every
 * user expects an email to behave.
 */
export function parseUsers(raw: string | undefined): ConsoleUser[] {
  const entries = parseJsonArray(raw, 'CONSOLE_USERS')

  return entries.map((entry, at) => {
    const user = entry as Partial<ConsoleUser>
    const where = `CONSOLE_USERS[${at}]`
    const email = requireString(user.email, `${where}.email`).trim().toLowerCase()
    const passwordHash = requireString(user.passwordHash, `${where}.passwordHash`)

    if (!passwordHash.startsWith('scrypt:')) {
      throw new ConsoleConfigError(
        `${where}.passwordHash must be a scrypt hash — generate one with \`npm run console:hash\`, never store a plain password`,
      )
    }

    return {
      email,
      name: typeof user.name === 'string' && user.name.trim() !== '' ? user.name : email,
      passwordHash,
    }
  })
}

function parseJsonArray(raw: string | undefined, name: string): unknown[] {
  if (!raw || raw.trim() === '') {
    return []
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConsoleConfigError(`${name} is not valid JSON: ${(error as Error).message}`)
  }

  if (!Array.isArray(parsed)) {
    throw new ConsoleConfigError(`${name} must be a JSON array`)
  }

  return parsed
}

function requireString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConsoleConfigError(`${where} is required`)
  }

  return value
}
