import { describe, it, expect } from 'vitest'
import { timingMiddleware, extractCallerNumber } from '../lib/vapi'
import { resolveFromPeopleFile, parsePeopleYaml, slugify } from '../lib/people'
import { readFileSync } from 'node:fs'
import type { People } from '../lib/types'

// Parse the (fictional) seed file so the tests track what ships.
const here = new URL('.', import.meta.url).pathname
const people: People = parsePeopleYaml(readFileSync(here + '../people.yaml', 'utf8'))

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

describe('resolveFromPeopleFile', () => {
  it('resolves a personal number to that person', () => {
    const r = resolveFromPeopleFile(people, '+15550123400')
    expect(r.personIds).toEqual(['maria'])
    expect(r.person?.name).toBe('Maria')
    expect(r.person?.myName).toBe('David')
  })

  it('returns no people for an unknown number', () => {
    const r = resolveFromPeopleFile(people, '+10000000000')
    expect(r.personIds).toEqual([])
    expect(r.person).toBeNull()
  })

  it('treats a number used by two people as a shared line', () => {
    const two: People = {
      ruth: { name: 'Ruth', myName: 'Chris', numbers: ['+18005551234'] },
      noah: { name: 'Noah', myName: 'Chris', numbers: ['+18005551234'] },
    }
    const r = resolveFromPeopleFile(two, '+18005551234')
    expect(r.personIds).toHaveLength(2)
    expect(r.personIds).toContain('ruth')
    expect(r.personIds).toContain('noah')
    expect(r.person).toBeNull()
  })

  it('a person with two numbers resolves from either one', () => {
    const multi: People = {
      maria: { name: 'Maria', myName: 'David', numbers: ['+15550123400', '+15550123401'] },
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

  it('derives id from name when id is omitted, and honors an explicit id', () => {
    const doc = `
people:
  - name: Sophie
    my_name: Chris
    phone_numbers: ["+15550123404"]
  - id: custom-slug
    name: Someone
    my_name: Chris
    phone_numbers: []
`
    const p = parsePeopleYaml(doc)
    expect(Object.keys(p).sort()).toEqual(['custom-slug', 'sophie'])
    expect(p.sophie.name).toBe('Sophie')
    expect(p['custom-slug'].name).toBe('Someone')
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