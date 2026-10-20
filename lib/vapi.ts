import type { AssistantRequestPayload } from './types'

// How fast we must answer the assistant-request webhook: 7.5s end-to-end
// (telephony cap), and Vapi's own guidance is to target < ~6s.
// The only network hop here is one Dynamo GetItem (~5ms). This is the budget
// check so a future edit (a second DB read, an outbound fetch) gets flagged.
export const ASSISTANT_REQUEST_BUDGET_MS = 7500

// Lambda Function URL events wrap the HTTP body as a string (base64 when
// isBase64Encoded). Return the parsed Vapi payload; pass through an
// already-parsed object (tests, direct invokes). Bad JSON -> {}.
export function parseWebhookBody(event: any): any {
  if (!event || typeof event !== 'object') return {}
  if (event.message) return event
  if (typeof event.body !== 'string') return {}
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function timingMiddleware(handler: (event: any) => Promise<any>) {
  return async (event: any) => {
    const start = Date.now()
    const response = await handler(event)
    const type = parseWebhookBody(event)?.message?.type
    const ms = Date.now() - start
    if (type === 'assistant-request' && ms > ASSISTANT_REQUEST_BUDGET_MS / 2) {
      console.warn(`assistant-request slow path: ${ms}ms (budget ${ASSISTANT_REQUEST_BUDGET_MS}ms)`)
    }
    return response
  }
}

// Look up the caller's phone number from an assistant-request payload.
// Returns E.164 (just "+" and digits) or null.
export function extractCallerNumber(payload: AssistantRequestPayload): string | null {
  const raw = payload?.message?.call?.customer?.number
  if (!raw) return null
  const e164 = raw.match(/^\+\d{7,15}$/)
  if (e164) return e164[0]
  // Some SIP paths arrive as sip:+1...@host — pull the number out.
  const sip = raw.match(/sip:(\+\d{7,15})@/)
  if (sip) return sip[1]
  // Last resort: whatever digits are in there.
  const digits = raw.replace(/[^\d+]/g, '')
  return /^\+\d{7,15}$/.test(digits) ? digits : null
}

// Whole seconds between two ISO timestamps, or undefined if either is
// missing/unparseable or the span is negative.
export function callDurationSeconds(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) return undefined
  const ms = Date.parse(endedAt) - Date.parse(startedAt)
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : undefined
}

// Timing-safe string comparison.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// The Vapi Server URL is public — anyone with the domain can POST here.
// bin/sync puts a shared secret on the phone number's server.headers, so the
// only legitimate sender is Vapi. Everything else gets 401 before any logic.
export function authGuard(handler: (event: any) => Promise<any>) {
  return async (event: any) => {
    const expected = process.env.VAPI_WEBHOOK_SECRET
    const provided: string | undefined = event?.headers?.['x-vapi-webhook-secret']
    if (!expected) {
      console.error('VAPI_WEBHOOK_SECRET is not set; rejecting webhook')
      return { statusCode: 500, body: JSON.stringify({ error: 'webhook secret not configured' }) }
    }
    if (!provided || !safeEqual(provided, expected)) {
      console.warn('webhook rejected: missing or bad secret')
      return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) }
    }
    return handler(event)
  }
}