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
// bin/vapi.py `vapi sync` references a Vapi custom credential (Bearer) on the
// phone number, so the only legitimate sender is Vapi. Everything else gets
// 401 before any logic.
//
// Accepted header formats (both carry the same secret):
//   Authorization: Bearer ***            <- current (custom credential)
//   x-vapi-webhook-secret: <secret>      <- legacy inline header, accepted
//                                           during the migration window
export function authGuard(handler: (event: any) => Promise<any>) {
  return async (event: any) => {
    const expected = process.env.VAPI_WEBHOOK_SECRET
    if (!expected) {
      console.error('VAPI_WEBHOOK_SECRET is not set; rejecting webhook')
      return { statusCode: 500, body: JSON.stringify({ error: 'webhook secret not configured' }) }
    }
    const provided = extractSecret(event?.headers)
    if (!provided || !safeEqual(provided, expected)) {
      console.warn('webhook rejected: missing or bad secret')
      return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) }
    }
    return handler(event)
  }
}

// Pull the secret out of the event headers, whichever header Vapi's
// credential is configured to send. Case-insensitive header lookup (HTTP
// headers are case-insensitive; Function URL events lower-case them).
function extractSecret(headers: Record<string, unknown> | undefined): string | undefined {
  if (!headers) return undefined
  const h: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v
  const auth = h['authorization']
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice('Bearer '.length).trim()
    if (token) return token
  }
  const legacy = h['x-vapi-webhook-secret']
  return typeof legacy === 'string' && legacy ? legacy : undefined
}