# Deploying the AI engine with the Petrosil app

For whoever runs the app's deployment. The app's AI tools (each brand's AI
price update, per-market rules, AI settings, Watched pages with "Check now"
and the crawler's findings, and Global settings › AI settings) call the AI
engine in `engine/`. Without it those screens say "The AI engine is not set up
on this server" and everything else in the app works as before.

The engine is the Python price module, brought into this repository. It is
**not** the live standalone module (`petrosil-standaloneModule` on Railway):
that one keeps running for the old PHP sites and is not touched by any of this.

## 1. What runs

The same image, built from `engine/Dockerfile` (build context `engine/`), runs
two processes:

| Process | `MODULE_PROCESS` | What it is | Reachable from |
|---|---|---|---|
| engine | *(unset)* | the JSON API the app calls, on `$PORT` (default 8094) | the app only — **never give it a public address** |
| crawler | `estate-crawler` | every brand's watched pages, every 15 minutes | nothing — it calls out only |

They can be two services, or two processes in one container. The app itself is
unchanged: its own `Dockerfile` does not include `engine/` (see `.dockerignore`).

## 2. The database

The engine keeps its tables in a schema called `engine`, in the **app's own
database** — no second database, no extra volume. Create the schema once:

```sql
CREATE SCHEMA IF NOT EXISTS engine;
```

The engine creates and migrates its tables itself on start-up.

## 3. Settings

**Engine and crawler** (the same values for both):

| Variable | Value |
|---|---|
| `DATABASE_URL` | the app's database URL, plus `options=-csearch_path%3Dengine` (e.g. `postgresql://…/railway?options=-csearch_path%3Dengine`). Add `sslmode=disable` only if the database refuses TLS. |
| `PRICE_API_TOKEN` | a long random secret. The app sends it; nothing else should know it. |
| `CONSOLE_SECRET` | a random string of 32+ characters (the engine's old console signs cookies with it; nobody needs to sign in there). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | a Gemini key. The engine will not start without one; the live standalone module's key will do. The providers actually used are set on the AI settings screen. |
| `AI_DEFAULT_MODEL` | optional, e.g. `gemini-2.5-flash` — only used before any provider is set up. |
| `CRAWL_INTERVAL_SECONDS` | optional, crawler only; default `900`. |

**The app** (added to what it already has):

| Variable | Value |
|---|---|
| `ENGINE_URL` | the engine's private address, e.g. `http://petrosil-engine.railway.internal:8094` |
| `ENGINE_TOKEN` | the same value as the engine's `PRICE_API_TOKEN` |

## 4. Once, after the first deploy

All from a machine that can reach the app's database.

1. **Connect the brands to the engine.** Gives each brand a token and tells the
   engine where the app's API is (the app's private address, port included):

   ```bash
   DATABASE_URL=<the app's database> \
   ENGINE_SITE_API_BASE=http://<the app's private address>:<port>/api/compat \
   npm run engine:link
   ```

2. **Copy the live AI settings** from the standalone module — the providers and
   their keys, each brand's instructions, rounding and model, the price rules,
   the per-market rounding. Dry run first; it changes nothing without `--apply`:

   ```bash
   docker run --rm <the engine image> python -m app.db.copy_live \
     --from "<the live standalone module's DATABASE_URL>" \
     --to   "<the app's database>?options=-csearch_path%3Dengine"
   # read what it would do, then the same command with --apply
   ```

   It never copies a brand's address or token (step 1 owns those), and never
   copies history (drafts, readings, usage) — the old module keeps that. Safe
   to run again.

3. **Bring over each brand's watched pages** from its old site's MySQL
   database, if the old site watched any:

   ```bash
   SOURCE_PASSWORD=<mysql password> npm run migrate:content -- \
     --from <old site's mysql database> --site <slug> --only crawl-watch \
     --host <mysql host> --port <mysql port>
   ```

## 5. Check it

- `GET <engine>/health` answers `{"ok":true}`.
- In the app, **Global settings › AI settings**: the providers are listed, and
  **Test it** on the default answers "… works — … replied "ready"".
- On a brand's **AI tools › AI price update**: the page opens with no error.
- The crawler's log shows `Pass complete over N brand(s).` every 15 minutes.

## 6. Later

When the old PHP sites are switched off, the live standalone module and its
crawler can be retired. Nothing in the app depends on them.
