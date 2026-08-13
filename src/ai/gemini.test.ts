import { describe, expect, it, vi } from 'vitest'

import { createGeminiDriver } from './gemini.js'

const KEY = 'AIzaSyFAKE-key-value-1234567890'

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const okBody = (text: string) => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 120 },
})

/** A driver whose fetch returns the given responses in order. */
const driverReturning = (...responses: Array<Response | Error>) => {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string | URL, _init?: RequestInit) => {
    calls.push(String(url))
    const next = responses.shift()

    if (next === undefined) throw new Error('fetch called more times than expected')
    if (next instanceof Error) throw next

    return next
  })

  return {
    driver: createGeminiDriver({ apiKey: KEY, fetch: fetchImpl as unknown as typeof fetch, backoffMs: 0 }),
    fetchImpl,
    calls,
  }
}

describe('geminiDriver.generate', () => {
  it('returns the text and token counts on success', async () => {
    const { driver } = driverReturning(jsonResponse(200, okBody('Prices rose broadly.')))

    const result = await driver.generate('gemini-2.5-flash', 'summarise this')

    expect(result).toMatchObject({
      status: 'complete',
      text: 'Prices rose broadly.',
      promptTokens: 300,
      completionTokens: 120,
    })
  })

  /**
   * The trap: Gemini answers HTTP 200 with an EMPTY candidates array and a
   * populated promptFeedback. Indexing candidates[0] first would throw, and a
   * model decline must never surface as a crash.
   */
  it('treats a 200 with a block reason and no candidates as declined', async () => {
    const { driver } = driverReturning(
      jsonResponse(200, { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }),
    )

    const result = await driver.generate('gemini-2.5-flash', 'summarise this')

    expect(result.status).toBe('declined')
    expect(result.error).toContain('SAFETY')
  })

  it('treats a 200 with no usable text as declined', async () => {
    const { driver } = driverReturning(jsonResponse(200, { candidates: [{ content: { parts: [] } }] }))

    const result = await driver.generate('gemini-2.5-flash', 'summarise this')

    expect(result.status).toBe('declined')
  })

  it('retries on a 429 and succeeds on the next attempt', async () => {
    const { driver, fetchImpl } = driverReturning(
      jsonResponse(429, { error: 'rate limited' }),
      jsonResponse(200, okBody('Second time lucky.')),
    )

    const result = await driver.generate('gemini-2.5-flash', 'summarise this')

    expect(result.status).toBe('complete')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries on a 500 up to three attempts then throws', async () => {
    const { driver, fetchImpl } = driverReturning(
      jsonResponse(500, {}),
      jsonResponse(500, {}),
      jsonResponse(500, {}),
    )

    await expect(driver.generate('gemini-2.5-flash', 'x')).rejects.toThrow(/500/)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry a 400', async () => {
    const { driver, fetchImpl } = driverReturning(jsonResponse(400, { error: 'bad request' }))

    await expect(driver.generate('gemini-2.5-flash', 'x')).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  /**
   * The key rides in the query string, so it is present in the request URL and
   * in anything that echoes it. Every thrown message must be scrubbed — an
   * unredacted one gets stored and shown to admins.
   */
  it('never leaks the api key in an http error', async () => {
    const { driver } = driverReturning(jsonResponse(400, { error: `bad key ${KEY}` }))

    await expect(driver.generate('gemini-2.5-flash', 'x')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(KEY) }),
    )
  })

  it('never leaks the api key when the network call itself fails', async () => {
    const { driver } = driverReturning(
      new Error(`connect ECONNREFUSED https://host/v1beta/models/x:generateContent?key=${KEY}`),
      new Error(`connect ECONNREFUSED https://host/v1beta/models/x:generateContent?key=${KEY}`),
      new Error(`connect ECONNREFUSED https://host/v1beta/models/x:generateContent?key=${KEY}`),
    )

    await expect(driver.generate('gemini-2.5-flash', 'x')).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(KEY) }),
    )
  })

  it('sends the key as a query parameter and the prompt as the user message', async () => {
    const { driver, fetchImpl, calls } = driverReturning(jsonResponse(200, okBody('ok')))

    await driver.generate('gemini-2.5-flash', 'the prompt text')

    expect(calls[0]).toContain('gemini-2.5-flash:generateContent')
    expect(calls[0]).toContain(`key=${encodeURIComponent(KEY)}`)

    const init = fetchImpl.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'the prompt text' }] }],
    })
  })
})
