import type { AiCompletion, AiDriver } from './types.js'

const MAX_ATTEMPTS = 3
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'

export class AiProviderError extends Error {
  override readonly name = 'AiProviderError'
}

export interface GeminiOptions {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  /** Injectable so tests don't actually wait. */
  backoffMs?: number
}

/**
 * Talks to Gemini's generateContent REST endpoint.
 *
 * Two behaviours here are load-bearing and were both found the hard way:
 *
 * 1. Gemini can answer HTTP 200 with NO usable text — an empty `candidates`
 *    array plus `promptFeedback.blockReason`. That shape is checked before
 *    candidates[0] is ever touched, and becomes a `declined` completion
 *    rather than a crash. A model decline must never surface as a 500.
 *
 * 2. The API key travels in the query string, so it appears in the request
 *    URL and in any error text that echoes it — including network-level
 *    failures that never produced a response. Every thrown message goes
 *    through redact(), because an unredacted one ends up stored and shown
 *    to admins.
 *
 * Retries twice (three attempts total) and only on 429/5xx; a 4xx such as a
 * bad request or bad key is not retried.
 */
export function createGeminiDriver(options: GeminiOptions): AiDriver {
  const {
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
    backoffMs = 50,
  } = options

  const redact = (text: string) => text.split(apiKey).join('***')

  async function generate(model: string, prompt: string): Promise<AiCompletion> {
    const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`
    let lastError: unknown = null

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
          }),
        })

        if (!response.ok) {
          const body = await response.text().catch(() => '')

          if (isRetryable(response.status) && attempt < MAX_ATTEMPTS) {
            await backoff(backoffMs, attempt)
            continue
          }

          throw new AiProviderError(
            redact(`Gemini request failed with HTTP ${response.status}: ${body}`),
          )
        }

        return parse((await response.json()) as GeminiResponse)
      } catch (error) {
        if (error instanceof AiProviderError) {
          throw error
        }

        lastError = error

        if (attempt < MAX_ATTEMPTS) {
          await backoff(backoffMs, attempt)
          continue
        }

        // No HTTP response came back at all (DNS failure, timeout, TLS error).
        // The message still embeds the full request URL, query string and all,
        // so it must be redacted exactly like the HTTP branch above.
        throw new AiProviderError(redact(`Gemini request failed: ${messageOf(error)}`))
      }
    }

    throw new AiProviderError(
      redact(`Gemini request failed after ${MAX_ATTEMPTS} attempts: ${messageOf(lastError)}`),
    )
  }

  return { generate }
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }
}

function parse(data: GeminiResponse): AiCompletion {
  // Check the block-reason shape BEFORE indexing candidates[0]: an empty
  // candidates array with a populated promptFeedback means the model
  // declined, not that the response is malformed.
  if ((data.candidates ?? []).length === 0 && data.promptFeedback?.blockReason) {
    return declined(`The model declined to respond: ${data.promptFeedback.blockReason}`)
  }

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text

  if (typeof text !== 'string' || text.trim() === '') {
    return declined('The model returned no usable content.')
  }

  return {
    status: 'complete',
    text,
    promptTokens: data.usageMetadata?.promptTokenCount ?? null,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? null,
    error: null,
  }
}

const declined = (error: string): AiCompletion => ({
  status: 'declined',
  text: null,
  promptTokens: null,
  completionTokens: null,
  error,
})

const isRetryable = (status: number) => status === 429 || status >= 500

const backoff = (base: number, attempt: number) =>
  base === 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, base * attempt))

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
