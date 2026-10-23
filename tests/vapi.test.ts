import { describe, it, expect, afterEach } from 'vitest'
import { timingMiddleware, extractCallerNumber, callDurationSeconds, parseWebhookBody, authGuard } from '../lib/vapi'
import { computeFrequency, describeFrequency } from '../lib/frequency'
import { personIdsFromStream } from '../functions/after-call'
import { resolveFromPeopleFile, parsePeopleYaml, slugify, fullName } from '../lib/people'
import { readFileSync } from 'node:fs'
import type { People } from '../lib/types'

// Parse the (fictional) seed file so the tests track what ships.
const here = new URL('.', import.meta.url).pathname
const people: People = parsePeopleYaml(readFileSync(here + '../people.example.yaml', 'utf8'))

describe('extractCallerNumber', () => {
  it('extracts a clean E.164 number', () => {
    const p = { message: { type: 'assistant-request', call: { customer: { number: '+15550123400' } } } }
    expect(extractCallerNumber(p as any)).toBe('+15550123400')
  })

  it('extracts the number out of a sip: URI', () => {
    const p = {
      message: { type: 'assistant-request', call: { customer: { number: 'sip:+15550123400@44.238.177.138:5060' } } },
    }
    expect(extractCallerNumber(p as any)).toBe('+15550123400')
  })

  it('returns null when there is no number', () => {
    const p = { message: { type: 'assistant-request', call: { customer: {} } } }
    expect(extractCallerNumber(p as any)).toBeNull()
  })
})

describe('callDurationSeconds', () => {
  it('computes whole seconds between start and end', () => {
    expect(callDurationSeconds('2026-10-16T14:00:00.000Z', '2026-10-16T14:03:25.400Z')).toBe(205)
  })
  it('is undefined when a timestamp is missing, bad, or reversed', () => {
    expect(callDurationSeconds(undefined, '2026-10-16T14:00:00Z')).toBeUndefined()
    expect(callDurationSeconds('2026-10-16T14:00:00Z', undefined)).toBeUndefined()
    expect(callDurationSeconds('nope', '2026-10-16T14:00:00Z')).toBeUndefined()
    expect(callDurationSeconds('2026-10-16T14:05:00Z', '2026-10-16T14:00:00Z')).toBeUndefined()
  })
})

describe('computeFrequency', () => {
  const now = new Date('2026-10-16T12:00:00Z')
  const calls = [
    '2026-10-16T11:00:00Z', // 1h ago
    '2026-10-15T13:00:00Z', // 23h ago
    '2026-10-15T11:00:00Z', // 25h ago
    '2026-10-10T12:00:00Z', // 6d ago
    '2026-09-20T12:00:00Z', // 26d ago
    '2026-09-01T12:00:00Z', // 45d ago — outside every window
    '2026-10-17T12:00:00Z', // future (clock skew) — ignored
  ]
  it('buckets calls into 24h / 7d / 30d windows', () => {
    const f = computeFrequency(calls, now)
    expect(f.callsLast24h).toBe(2)
    expect(f.callsLast7d).toBe(4)
    expect(f.callsLast30d).toBe(5)
    expect(f.recentCalls[0]).toBe('2026-10-16T11:00:00Z')
    expect(f.recentCalls).toHaveLength(5)
  })
  it('dedupes repeated timestamps and decays as time passes', () => {
    const later = new Date('2026-10-20T12:00:00Z')
    const f = computeFrequency([...calls, calls[0]], later)
    expect(f.callsLast24h).toBe(0)
    // 10-16, 10-15 x2, and the formerly-future 10-17 are now within a week.
    expect(f.callsLast7d).toBe(4)
  })
  it('describes the counts for the prompt', () => {
    expect(describeFrequency(computeFrequency(calls, now))).toBe(
      '2 calls in the last 24 hours, 4 in the last week, 5 in the last month',
    )
    expect(describeFrequency({ callsLast24h: 0, callsLast7d: 1, callsLast30d: 1 })).toBe(
      '0 calls in the last 24 hours, 1 in the last week, 1 in the last month',
    )
    expect(describeFrequency(computeFrequency([], now))).toBe('')
  })
})

describe('personIdsFromStream', () => {
  it('takes personal-line INSERTs only, deduped', () => {
    const rec = (eventName: string, personId: string) => ({ eventName, dynamodb: { NewImage: { personId: { S: personId } } } })
    const ids = personIdsFromStream({
      Records: [rec('INSERT', 'maria'), rec('INSERT', 'maria'), rec('INSERT', 'unknown'),
                rec('INSERT', 'shared'), rec('MODIFY', 'sam'), rec('INSERT', 'ruth')] as any,
    })
    expect(ids.sort()).toEqual(['maria', 'ruth'])
  })
})

describe('parseWebhookBody', () => {
  const payload = { message: { type: 'assistant-request' } }
  it('parses a Function URL string body, plain or base64', () => {
    expect(parseWebhookBody({ body: JSON.stringify(payload) })).toEqual(payload)
    expect(parseWebhookBody({ body: Buffer.from(JSON.stringify(payload)).toString('base64'), isBase64Encoded: true })).toEqual(payload)
  })
  it('passes through an already-parsed payload; bad input -> {}', () => {
    expect(parseWebhookBody(payload)).toBe(payload)
    expect(parseWebhookBody({ body: 'not json' })).toEqual({})
    expect(parseWebhookBody(undefined)).toEqual({})
  })
})

describe('resolveFromPeopleFile', () => {
  it('resolves a personal number to that person', () => {
    const r = resolveFromPeopleFile(people, '+15550123400')
    expect(r.personIds).toEqual(['maria'])
    expect(fullName(r.person!)).toBe('Maria Sample')
    expect(r.person?.myName).toBe('David')
  })

  it('returns no people for an unknown number', () => {
    const r = resolveFromPeopleFile(people, '+1000000000')
    expect(r.personIds).toEqual([])
    expect(r.person).toBeNull()
  })

  it('treats a number used by two people as a shared line', () => {
    const two: People = {
      ruth: { firstName: 'Ruth', myName: 'Chris', numbers: ['+18005551234'] },
      noah: { firstName: 'Noah', myName: 'Chris', numbers: ['+18005551234'] },
    }
    const r = resolveFromPeopleFile(two, '+18005551234')
    expect(r.personIds).toHaveLength(2)
    expect(r.personIds).toContain('ruth')
    expect(r.personIds).toContain('noah')
    expect(r.person).toBeNull()
  })

  it('a person with two numbers resolves from either one', () => {
    const multi: People = {
      maria: { firstName: 'Maria', lastName: 'DeRose', myName: 'David', numbers: ['+15550123400', '+15550123401'] },
    }
    expect(resolveFromPeopleFile(multi, '+15550123401').personIds).toEqual(['maria'])
    expect(resolveFromPeopleFile(multi, '+15550123400').personIds).toEqual(['maria'])
  })
})

describe('slugify', () => {
  it('derives a slug from a name', () => {
    expect(slugify('Maria')).toBe('maria')
    expect(slugify("Ruth's Son")).toBe("ruth-s-son")
    expect(slugify('  Sam  ')).toBe('sam')
  })
})

describe('parsePeopleYaml', () => {
  it('parses the seed file into the people map', () => {
    expect(Object.keys(people).sort()).toEqual(['maria', 'noah', 'ruth', 'sam'])
    expect(people.maria.myName).toBe('David')
    expect(people.maria.numbers).toContain('+15550123400')
    expect(people.sam.myName).toBe('Chris')
  })

  it('reads personal_notes and llm_notes as separate fields', () => {
    expect(people.maria.personalNotes).toBe('Loves hearing about the latest build.')
    expect(people.maria.llmNotes).toBe('Prefers calls in the afternoon.')
    expect(people.sam.personalNotes).toBeUndefined()
  })

  it('reads the per-person attitude (sample: warm for maria, unset for sam)', () => {
    expect(people.maria.attitude).toBe('warm')
    expect(people.sam.attitude).toBeUndefined()
  })

  it('derives id from the full name when id is omitted, and honors an explicit id', () => {
    const doc = `
people:
  - first_name: Sophie
    my_name: Chris
    phone_numbers: ["+15550123404"]
  - first_name: Jane
    last_name: Doe
    my_name: Chris
    phone_numbers: []
  - id: custom-slug
    first_name: Some
    last_name: One
    my_name: Chris
    phone_numbers: []
`
    const p = parsePeopleYaml(doc)
    expect(Object.keys(p).sort()).toEqual(['custom-slug', 'jane-doe', 'sophie'])
    expect(fullName(p.sophie)).toBe('Sophie')
    expect(fullName(p['jane-doe'])).toBe('Jane Doe')
    expect(fullName(p['custom-slug'])).toBe('Some One')
  })

  it('still accepts a legacy single `name` field', () => {
    const doc = `
people:
  - name: Legacy Person
    my_name: Chris
    phone_numbers: []
`
    const p = parsePeopleYaml(doc)
    expect(p['legacy-person'].firstName).toBe('Legacy Person')
    expect(fullName(p['legacy-person'])).toBe('Legacy Person')
  })

  it('returns an empty map for a file with no people', () => {
    expect(parsePeopleYaml('people: []')).toEqual({})
    expect(parsePeopleYaml('')).toEqual({})
  })
})

describe('timingMiddleware', () => {
  it('passes the response through unchanged', async () => {
    const handler = timingMiddleware(async () => ({ statusCode: 200, body: 'ok' }))
    await expect(handler({})).resolves.toEqual({ statusCode: 200, body: 'ok' })
  })
})

describe('authGuard', () => {
  const SECRET = 'test-secret-123'
  const orig = process.env.VAPI_WEBHOOK_SECRET
  const handler = authGuard(async () => ({ statusCode: 200, body: JSON.stringify({ ok: true }) }))

  afterEach(() => {
    process.env.VAPI_WEBHOOK_SECRET = orig
  })

  it('accepts Authorization: Bearer <token> (custom credential format)', async () => {
    process.env.VAPI_WEBHOOK_SECRET = SECRET
    const r = await handler({ headers: { authorization: `Bearer ${SECRET}` }, body: '{}' } as any)
    expect(r.statusCode).toBe(200)
    expect(JSON.parse(r.body)).toEqual({ ok: true })
  })

  it('is case-insensitive on header names', async () => {
    process.env.VAPI_WEBHOOK_SECRET = SECRET
    const r = await handler({ headers: { Authorization: `Bearer ${SECRET}` }, body: '{}' } as any)
    expect(r.statusCode).toBe(200)
  })

  it('rejects a wrong bearer token with 401', async () => {
    process.env.VAPI_WEBHOOK_SECRET = SECRET
    const r = await handler({ headers: { authorization: 'Bearer wrong' }, body: '{}' } as any)
    expect(r.statusCode).toBe(401)
  })

  it('rejects a missing/empty bearer prefix or token', async () => {
    process.env.VAPI_WEBHOOK_SECRET = SECRET
    expect((await handler({ headers: { authorization: SECRET }, body: '{}' } as any)).statusCode).toBe(401)
    expect((await handler({ headers: { authorization: 'Bearer ' }, body: '{}' } as any)).statusCode).toBe(401)
    expect((await handler({ headers: {}, body: '{}' } as any)).statusCode).toBe(401)
    expect((await handler({} as any)).statusCode).toBe(401)
  })

  it('fails closed (500) when VAPI_WEBHOOK_SECRET is not configured', async () => {
    delete process.env.VAPI_WEBHOOK_SECRET
    const r = await handler({ headers: { authorization: `Bearer ${SECRET}` }, body: '{}' } as any)
    expect(r.statusCode).toBe(500)
  })
})
