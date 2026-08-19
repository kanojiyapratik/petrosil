/**
 * Generates a CONSOLE_USERS password hash.
 *
 *   npm run console:hash -- 'the password'
 *
 * Exists so a plain password never has to be pasted into an env var or a
 * chat window on the way to one.
 */
import { hashPassword } from './auth.js'

const password = process.argv[2] ?? ''

if (password.length < 8) {
  console.error('Usage: npm run console:hash -- <password>   (8 characters or more)')
  process.exit(1)
}

hashPassword(password).then((hash) => {
  console.log(hash)
})
