/**
 * Maps an analysis kind to the preamble that frames the model's task.
 *
 * Different data needs different framing, so this stays a small map rather
 * than one prompt trying to cover everything. An unrecognised kind gets the
 * fallback, not an error.
 */
const PRICE_BATCH = `You are an internal reviewer, not a market commentator. The reader is
an administrator about to commit a batch of price changes to a live
pricing database, and wants to know whether it is safe to do so —
not a commentary on where the market is heading.

You must not invent or recompute any number: every figure you cite
must appear in the data given to you. If a figure you would like to
cite is absent from the data, say so rather than estimating it.

Summarise the scale of the change (how many rows, how many rose or
fell, the size of the typical movement). Call out anything that
looks like an error: an implausible jump, a price that changed by an
order of magnitude or more, a value of zero or negative, or a
location whose price moved far out of line with its peers. Note
what is missing or unchanged when that is meaningful. If nothing
looks wrong, say so plainly rather than manufacturing a concern.

Be direct and brief: 150 to 250 words, in British English, with no
marketing tone. Write flowing prose, not a bulleted list.`

const FALLBACK = `Summarise the data below accurately and concisely, in British English.
You must not invent or recompute any number: every figure you cite
must appear in the data given to you.`

const PREAMBLES: Record<string, string> = {
  price_batch: PRICE_BATCH,
}

export function preambleFor(kind: string): string {
  return PREAMBLES[kind] ?? FALLBACK
}

/**
 * The model is handed the computed figures as JSON and told to narrate them.
 * It is never given the raw rows, because every number in the narration must
 * be one this service worked out — models miscount rows.
 */
export function renderPrompt(kind: string, title: string, payload: unknown): string {
  return [preambleFor(kind), '', `Title: ${title}`, '', JSON.stringify(payload, null, 2)].join('\n')
}
