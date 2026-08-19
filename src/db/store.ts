import type { Pool } from 'pg'

import type { ConsoleSite, ConsoleUser } from '../console/config.js'

/**
 * The console's own data: who can sign in, and which sites they can work on.
 *
 * This is the only database the module has, and it holds no price data --
 * prices stay on the sites, reached over their APIs. What lives here is the
 * configuration that used to be env vars, now editable from the screens
 * because adding a site should not need a redeploy.
 */

export interface StoredUser extends ConsoleUser {
  id: number
  isAdmin: boolean
  disabledAt: string | null
}

export interface StoredSite extends ConsoleSite {
  dbId: number
  enabled: boolean
}

export interface AuditEntry {
  userEmail: string
  siteSlug: string | null
  action: string
  detail: string | null
  createdAt: string
}

export function createStore(pool: Pool) {
  return {
    async users(): Promise<StoredUser[]> {
      const { rows } = await pool.query(
        `SELECT id, email, name, password_hash, is_admin, disabled_at
           FROM console_users ORDER BY lower(email)`,
      )

      return rows.map(toUser)
    },

    /**
     * Only accounts that can actually sign in.
     *
     * Disabling rather than deleting keeps the audit trail readable: a
     * deleted user's actions would otherwise point at nobody.
     */
    async activeUsers(): Promise<StoredUser[]> {
      const { rows } = await pool.query(
        `SELECT id, email, name, password_hash, is_admin, disabled_at
           FROM console_users WHERE disabled_at IS NULL ORDER BY lower(email)`,
      )

      return rows.map(toUser)
    },

    async createUser(user: {
      email: string
      name: string
      passwordHash: string
      isAdmin: boolean
    }): Promise<StoredUser> {
      const { rows } = await pool.query(
        `INSERT INTO console_users (email, name, password_hash, is_admin)
              VALUES ($1, $2, $3, $4)
           RETURNING id, email, name, password_hash, is_admin, disabled_at`,
        [user.email.trim().toLowerCase(), user.name, user.passwordHash, user.isAdmin],
      )

      return toUser(rows[0])
    },

    async setUserPassword(id: number, passwordHash: string): Promise<void> {
      await pool.query(
        'UPDATE console_users SET password_hash = $2, updated_at = now() WHERE id = $1',
        [id, passwordHash],
      )
    },

    async setUserDisabled(id: number, disabled: boolean): Promise<void> {
      await pool.query(
        `UPDATE console_users
            SET disabled_at = CASE WHEN $2 THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1`,
        [id, disabled],
      )
    },

    async sites(): Promise<StoredSite[]> {
      const { rows } = await pool.query(
        `SELECT id, slug, name, api_url, api_token, enabled
           FROM console_sites ORDER BY name`,
      )

      return rows.map(toSite)
    },

    async enabledSites(): Promise<StoredSite[]> {
      const { rows } = await pool.query(
        `SELECT id, slug, name, api_url, api_token, enabled
           FROM console_sites WHERE enabled ORDER BY name`,
      )

      return rows.map(toSite)
    },

    async siteBySlug(slug: string): Promise<StoredSite | null> {
      const { rows } = await pool.query(
        `SELECT id, slug, name, api_url, api_token, enabled
           FROM console_sites WHERE slug = $1`,
        [slug],
      )

      return rows[0] ? toSite(rows[0]) : null
    },

    async upsertSite(site: {
      slug: string
      name: string
      apiUrl: string
      apiToken: string
      enabled: boolean
    }): Promise<StoredSite> {
      // An empty token on an update means "leave the stored one alone", so a
      // rename never silently wipes the credential the screens depend on.
      const { rows } = await pool.query(
        `INSERT INTO console_sites (slug, name, api_url, api_token, enabled)
              VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE
                SET name = EXCLUDED.name,
                    api_url = EXCLUDED.api_url,
                    api_token = CASE WHEN EXCLUDED.api_token = '' THEN console_sites.api_token
                                     ELSE EXCLUDED.api_token END,
                    enabled = EXCLUDED.enabled,
                    updated_at = now()
           RETURNING id, slug, name, api_url, api_token, enabled`,
        [site.slug, site.name, site.apiUrl, site.apiToken, site.enabled],
      )

      return toSite(rows[0])
    },

    async record(entry: {
      userEmail: string
      siteSlug?: string | null
      action: string
      detail?: string | null
    }): Promise<void> {
      await pool.query(
        `INSERT INTO console_audit (user_email, site_slug, action, detail)
              VALUES ($1, $2, $3, $4)`,
        [entry.userEmail, entry.siteSlug ?? null, entry.action, entry.detail ?? null],
      )
    },

    async audit(limit = 100, siteSlug?: string): Promise<AuditEntry[]> {
      const { rows } = siteSlug
        ? await pool.query(
            `SELECT user_email, site_slug, action, detail, created_at
               FROM console_audit WHERE site_slug = $1
              ORDER BY id DESC LIMIT $2`,
            [siteSlug, limit],
          )
        : await pool.query(
            `SELECT user_email, site_slug, action, detail, created_at
               FROM console_audit ORDER BY id DESC LIMIT $1`,
            [limit],
          )

      return rows.map((row) => ({
        userEmail: row.user_email,
        siteSlug: row.site_slug,
        action: row.action,
        detail: row.detail,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      }))
    },
  }
}

export type Store = ReturnType<typeof createStore>

/**
 * Copies CONSOLE_SITES / CONSOLE_USERS into the database once.
 *
 * Only ever adds what is missing: the env vars were how this was configured
 * before, and a boot that overwrote an edit made through the screens would
 * undo the whole point of moving configuration into the database.
 */
export async function seed(
  store: Store,
  seedUsers: ConsoleUser[],
  seedSites: ConsoleSite[],
): Promise<{ users: number; sites: number }> {
  const existingUsers = new Set((await store.users()).map((user) => user.email))
  const existingSites = new Set((await store.sites()).map((site) => site.id))
  let users = 0
  let sites = 0

  for (const user of seedUsers) {
    if (existingUsers.has(user.email)) {
      continue
    }

    // The first account in has to be able to add the others.
    await store.createUser({ ...user, isAdmin: true })
    users++
  }

  for (const site of seedSites) {
    if (existingSites.has(site.id)) {
      continue
    }

    await store.upsertSite({
      slug: site.id,
      name: site.name,
      apiUrl: site.apiUrl,
      apiToken: site.token,
      enabled: true,
    })
    sites++
  }

  return { users, sites }
}

const toUser = (row: any): StoredUser => ({
  id: Number(row.id),
  email: row.email,
  name: row.name,
  passwordHash: row.password_hash,
  isAdmin: row.is_admin === true,
  disabledAt: row.disabled_at ? new Date(row.disabled_at).toISOString() : null,
})

const toSite = (row: any): StoredSite => ({
  dbId: Number(row.id),
  id: row.slug,
  name: row.name,
  apiUrl: row.api_url,
  token: row.api_token,
  enabled: row.enabled === true,
})
