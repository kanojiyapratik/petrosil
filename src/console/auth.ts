import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

import type { ConsoleUser } from './config.js'

/**
 * Sign-in for the console.
 *
 * Passwords are scrypt-hashed and sessions are HMAC-signed cookies. No
 * session store: the module runs as one process with no database, and a
 * signed cookie carrying the email and an expiry is enough to know who is
 * asking without keeping server-side state.
 *
 * The trade-off is honest and worth naming: a signed cookie cannot be
 * revoked before it expires. Sessions are therefore short, and changing
 * CONSOLE_SECRET invalidates every one of them at once.
 */

const SCRYPT_KEYLEN = 64
const DEFAULT_TTL_SECONDS = 12 * 60 * 60

export const SESSION_COOKIE = 'petrosil_console'

export function hashPassword(password: string, salt: Uint8Array = randomBytes(16)): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEYLEN, (error, derived) => {
      if (error) {
        reject(error)
        return
      }

      resolve(`scrypt:${Buffer.from(salt).toString('hex')}:${derived.toString('hex')}`)
    })
  })
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(':')

  if (scheme !== 'scrypt' || !saltHex || !hashHex) {
    return false
  }

  let salt: Buffer
  let expected: Buffer

  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }

  const actual = await hashPassword(password, salt)
  const actualHex = actual.split(':')[2] ?? ''
  const actualBuffer = Buffer.from(actualHex, 'hex')

  if (actualBuffer.length !== expected.length) {
    return false
  }

  return timingSafeEqual(Uint8Array.from(actualBuffer), Uint8Array.from(expected))
}

/**
 * Finds the user and checks the password.
 *
 * An unknown email still costs a password hash, so a wrong address and a
 * wrong password take the same time to reject and the response cannot be
 * used to enumerate who has an account.
 */
export async function authenticate(
  users: ConsoleUser[],
  email: string,
  password: string,
): Promise<ConsoleUser | null> {
  const wanted = email.trim().toLowerCase()
  const user = users.find((candidate) => candidate.email === wanted)

  if (!user) {
    await verifyPassword(password, `scrypt:${'00'.repeat(16)}:${'00'.repeat(SCRYPT_KEYLEN)}`)
    return null
  }

  return (await verifyPassword(password, user.passwordHash)) ? user : null
}

export interface Session {
  email: string
  /** Unix seconds. */
  expiresAt: number
}

export function signSession(session: Session, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url')

  return `${payload}.${sign(payload, secret)}`
}

/** Returns null for anything tampered with, malformed, or past its expiry. */
export function readSession(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) {
    return null
  }

  const [payload, signature] = token.split('.')

  if (!payload || !signature) {
    return null
  }

  const expected = sign(payload, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)

  if (a.length !== b.length || !timingSafeEqual(Uint8Array.from(a), Uint8Array.from(b))) {
    return null
  }

  let session: Session

  try {
    session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session
  } catch {
    return null
  }

  if (typeof session.email !== 'string' || typeof session.expiresAt !== 'number') {
    return null
  }

  return session.expiresAt * 1000 > now ? session : null
}

export const newSession = (email: string, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()): Session => ({
  email,
  expiresAt: Math.floor(now / 1000) + ttlSeconds,
})

const sign = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest('base64url')
