export type AiStatus = 'complete' | 'declined'

export interface AiCompletion {
  status: AiStatus
  text: string | null
  promptTokens: number | null
  completionTokens: number | null
  /** Why the model declined, when it did. */
  error: string | null
}

export interface AiDriver {
  generate(model: string, prompt: string): Promise<AiCompletion>
}
