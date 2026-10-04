import { ManagedServer } from './managed-server'
import type { Logger } from '../logger'
import { LIMITS } from '../../shared/constants'
import { LLM_GRAMMAR } from '../../shared/schemas'
import { threadCount } from './transcription-engine'

export interface ClassifierOutput {
  raw: string
  ms: number
}

export interface Classifier {
  readonly modelId: string | null
  isReady(): boolean
  classify(transcript: string, opts?: { temperature?: number }): Promise<ClassifierOutput>
}

export class ClassificationError extends Error {
  constructor(
    readonly code: 'LLM_UNAVAILABLE' | 'LLM_TIMEOUT' | 'LLM_FAILED',
    message: string
  ) {
    super(message)
  }
}

export const SYSTEM_PROMPT = `You organize short voice notes. Read the transcript and reply with one JSON object.

Categories:
- "task": something the speaker intends to do, with no specific moment to be reminded at. Examples: "fix the login bug", "buy milk", "investigate why the worker retries jobs".
- "reminder": the speaker asks to be reminded, or something must happen at a stated date or time. Examples: "remind me tomorrow to call the dentist", "pay rent on the 1st", "meeting with Sam at 4pm".
- "idea": a possibility or concept to explore later. Examples: "I could build a tool that explains query plans", "what if the app had a dark mode".
- "reference": a fact or piece of information to keep, not an action. Examples: "the staging server uses port 8081", "Priya's wifi password is on the fridge".

Fields:
- title: 2 to 6 words. Start tasks and reminders with a verb.
- summary: one short sentence restating the note. Do not add facts that were not said.
- action: the concrete action for a task or reminder, otherwise null.
- date_expression: copy the exact words from the transcript that say when, such as "tomorrow morning" or "next Friday at 5 pm". Use null when no time is mentioned. Never invent, compute or reformat a date.
- needs_confirmation: true only when the category is genuinely unclear. Then give a short reason; otherwise reason is null.
- confidence: a number from 0 to 1.`

const EXAMPLES: Array<[string, object]> = [
  [
    'Remind me tomorrow morning to call the dentist about the appointment.',
    {
      category: 'reminder',
      title: 'Call the dentist',
      summary: 'Call the dentist about the appointment.',
      action: 'Call the dentist about the appointment',
      date_expression: 'tomorrow morning',
      needs_confirmation: false,
      reason: null,
      confidence: 0.95
    }
  ],
  [
    'Okay so the staging server uses port 8081, not 8080.',
    {
      category: 'reference',
      title: 'Staging server port',
      summary: 'The staging server uses port 8081, not 8080.',
      action: null,
      date_expression: null,
      needs_confirmation: false,
      reason: null,
      confidence: 0.93
    }
  ],
  [
    'I need to look into why the background worker keeps retrying failed jobs.',
    {
      category: 'task',
      title: 'Investigate background worker retries',
      summary: 'Investigate why the background worker keeps retrying failed jobs.',
      action: 'Investigate why the background worker retries failed jobs',
      date_expression: null,
      needs_confirmation: false,
      reason: null,
      confidence: 0.9
    }
  ],
  [
    'What if there was a tool that explains Postgres query plans in plain English.',
    {
      category: 'idea',
      title: 'Plain-English query plan explainer',
      summary: 'A tool that explains PostgreSQL query plans in plain English.',
      action: null,
      date_expression: null,
      needs_confirmation: false,
      reason: null,
      confidence: 0.9
    }
  ]
]

export function buildMessages(transcript: string): Array<{ role: string; content: string }> {
  const msgs: Array<{ role: string; content: string }> = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const [t, out] of EXAMPLES) {
    msgs.push({ role: 'user', content: `Transcript: """${t}"""` })
    msgs.push({ role: 'assistant', content: JSON.stringify(out) })
  }
  const clipped = transcript.slice(0, LIMITS.maxClassifierInputChars).replace(/"""/g, '"')
  msgs.push({ role: 'user', content: `Transcript: """${clipped}"""` })
  return msgs
}

/** llama.cpp's llama-server, kept warm; output is constrained by a JSON-schema grammar. */
export class LlamaEngine implements Classifier {
  server: ManagedServer | null = null
  modelId: string | null = null
  private config: { binary: string; modelPath: string } | null = null
  private idleTimer: NodeJS.Timeout | null = null
  idleUnloadMinutes = 0

  constructor(private readonly logger: Logger) {}

  async configure(binary: string, modelPath: string, modelId: string, contextSize: number): Promise<void> {
    if (this.config?.binary === binary && this.config?.modelPath === modelPath && this.server) return
    await this.server?.stop()
    this.config = { binary, modelPath }
    this.modelId = modelId
    this.server = new ManagedServer({
      name: 'llama-server',
      binary,
      args: [
        '-m',
        modelPath,
        '-c',
        String(contextSize),
        // Small micro-batch: the logits buffer is ubatch x 152k vocab, so 256 saves ~90 MB with no
        // measurable latency cost for ~20-token transcripts.
        '-ub',
        '256',
        '-np',
        '1',
        '-t',
        String(threadCount()),
        '--no-webui',
        '--jinja'
      ],
      healthPath: '/health',
      startupTimeoutMs: 180_000,
      logger: this.logger
    })
  }

  /** True while the warm-up request runs; the model is not offered to the pipeline until done. */
  warming = false

  isReady(): boolean {
    return this.server?.state === 'ready' && !this.warming
  }

  async classify(transcript: string, opts: { temperature?: number } = {}): Promise<ClassifierOutput> {
    if (!this.server || this.server.state !== 'ready') {
      throw new ClassificationError('LLM_UNAVAILABLE', 'The language model is not loaded yet.')
    }
    const t0 = Date.now()
    let res: Response
    try {
      res = await fetch(`${this.server.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          messages: buildMessages(transcript),
          temperature: opts.temperature ?? 0,
          max_tokens: LIMITS.maxLlmOutputTokens,
          cache_prompt: true,
          grammar: LLM_GRAMMAR,
          // Gemma 4 (and other "thinking" models) would otherwise spend the whole token budget
          // reasoning before answering; classification doesn't need it. Ignored by other templates.
          chat_template_kwargs: { enable_thinking: false }
        }),
        signal: AbortSignal.timeout(LIMITS.classificationTimeoutMs)
      })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') {
        throw new ClassificationError('LLM_TIMEOUT', 'The language model took too long to respond.')
      }
      throw new ClassificationError('LLM_FAILED', 'The language model stopped responding.')
    } finally {
      this.touch()
    }
    if (!res.ok) throw new ClassificationError('LLM_FAILED', `Language model error (HTTP ${res.status}).`)
    const body = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>
    } | null
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string')
      throw new ClassificationError('LLM_FAILED', 'Unexpected response from the model.')
    return { raw: content, ms: Date.now() - t0 }
  }

  /**
   * Runs one throwaway classification so llama-server caches the KV state of the system
   * prompt and examples (~700 tokens). Later requests then only process the new transcript.
   */
  async warmUp(): Promise<number | null> {
    if (this.server?.state !== 'ready') {
      this.warming = false
      return null
    }
    const t0 = Date.now()
    this.warming = true
    try {
      await this.classify('Warm-up: buy milk.')
      return Date.now() - t0
    } catch (err) {
      this.logger.warn('llama-server: warm-up failed', { err: err as Error })
      return null
    } finally {
      this.warming = false
    }
  }

  /** Restarts the idle-unload countdown (0 = keep the model loaded). */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.idleUnloadMinutes > 0) {
      this.idleTimer = setTimeout(() => {
        this.logger.info('llama-server: unloading after idle period')
        this.server?.stop().catch(() => undefined)
      }, this.idleUnloadMinutes * 60_000)
      this.idleTimer.unref()
    }
  }
}
