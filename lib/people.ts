import { load } from 'js-yaml'
import type { People, PersonFileEntry, Person } from './types'

// The resolved profile for a personal line. From the file it's a full
// PersonFileEntry; from Dynamo it's a Person (no `numbers`). Union of both.
export type ResolvedPerson = (PersonFileEntry & Partial<Pick<Person, 'followUps'>>)
  | (Person & { numbers?: string[] })

export interface Resolution {
  // Everyone who calls from this line. Empty = unknown line; length 1 = a
  // personal line (person is set); > 1 = a shared line (person is null).
  personIds: string[]
  // The one profile when the line is personal. Null for shared/unknown lines.
  person: ResolvedPerson | null
}

// Derive a slug from a name ("Milo's Mom" -> "milo-s-mom"). Mirrors the Python
// slugify so the same name yields the same id in YAML and in the CLI.
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

// One person as written in people.yaml.
export interface YamlPerson {
  id?: string
  first_name: string
  last_name?: string
  // Legacy (pre-rename) entries used a single `name`.
  name?: string
  my_name?: string
  relationship?: string
  attitude?: string
  phone_numbers?: string[]
  personal_notes?: string
  llm_notes?: string
  follow_ups?: string
}

// Display name from first/last (or the legacy single `name`).
export function fullName(p: { firstName?: string; lastName?: string; name?: string }): string {
  const parts = [p.firstName, p.lastName].filter((x): x is string => !!x)
  return parts.length ? parts.join(' ') : (p.name ?? '')
}

// Parse people.yaml text into the slug -> entry map the rest of the code uses.
// `id` falls back to a slug derived from the full name. Two people listing the
// same number both end up with it in `numbers` — shared-line detection is a
// property of the resolved list, not of the file.
export function parsePeopleYaml(text: string): People {
  if (!text || !text.trim()) return {}
  const doc = (load(text) ?? {}) as { people?: YamlPerson[] }
  const out: People = {}
  for (const p of doc.people ?? []) {
    const first = typeof p.first_name === 'string' ? p.first_name : ''
    const legacyName = typeof p.name === 'string' ? p.name : ''
    // No usable name at all -> skip (a person needs a first_name, or a legacy `name`).
    if (!first && !legacyName) continue
    // A bare number in YAML parses as a number; the id must be a string slug.
    // Coerce to the name-derived slug (mirrors bin/vapi.py) — a bad file must
    // never drop a call.
    const slug = (typeof p.id === 'string' && p.id) ? p.id : slugify(fullName({ firstName: first, lastName: p.last_name, name: legacyName || undefined }))
    out[slug] = {
      // first_name wins; a legacy-only entry's `name` becomes the firstName.
      firstName: first || legacyName,
      lastName: p.last_name,
      ...(first ? {} : { name: legacyName }),
      myName: p.my_name ?? 'Chris',
      relationship: p.relationship,
      attitude: p.attitude,
      numbers: p.phone_numbers ?? [],
      personalNotes: p.personal_notes,
      llmNotes: p.llm_notes,
    }
  }
  return out
}

// The in-repo seed + fallback, bundled into the Lambda. Dynamo is the live
// source; this file is what the webhook falls back to when Dynamo is down.
// people.yaml is copied to the function bundle root (scripts/bundle.mjs).
// We probe
// a few candidate locations (cwd, and the directory this module lives in) so
// it works whether cwd is the bundle root or the repo root. A missing or
// unparseable file yields {} (treat everyone as unknown) rather than throwing
// — a bad file must never drop a call.
export async function loadPeopleFile(): Promise<People> {
  try {
    const { readFileSync, existsSync } = await import('node:fs')
    const { cwd } = await import('node:process')
    const { join } = await import('node:path')
    // The deployed bundle is CJS (scripts/bundle.mjs), where import.meta does
    // not exist; there __dirname is index.cjs's directory — the bundle root.
    // In native ESM (tests) __dirname is undefined, so the cwd probe alone.
    const here = typeof __dirname !== 'undefined' ? __dirname : ''
    const candidates = [join(cwd(), 'people.yaml')]
    if (here) candidates.push(join(here, 'people.yaml'))
    for (const p of candidates) {
      if (existsSync(p)) return parsePeopleYaml(readFileSync(p, 'utf8'))
    }
    console.error('people.yaml fallback not found; probing:', candidates)
    return {}
  } catch (err) {
    console.error('could not load people.yaml fallback:', err)
    return {}
  }
}

// Resolve an incoming phone number to the people on that line, from the
// people map. Pure function of the data, so it's testable without AWS.
export function resolveFromPeopleFile(people: People, number: string): Resolution {
  const personIds = Object.keys(people).filter((id) => people[id].numbers.includes(number))
  if (personIds.length === 1) {
    const [personId] = personIds
    return { personIds, person: people[personId] }
  }
  return { personIds, person: null }
}

export function fromPersonDynamo(item: Record<string, any>): Person {
  const out: Person = { id: item.id?.S }
  for (const k of ['firstName', 'lastName', 'name', 'myName', 'relationship', 'attitude', 'personalNotes', 'llmNotes', 'followUps', 'lastCalled']) {
    if (item[k]?.S !== undefined) (out as any)[k] = item[k].S
  }
  // pre-rename rows: a legacy `profile` attribute is the old personal notes.
  if (out.personalNotes === undefined && item.profile?.S !== undefined) out.personalNotes = item.profile.S
  if (item.calls?.N !== undefined) out.calls = Number(item.calls.N)
  for (const k of ['callsLast24h', 'callsLast7d', 'callsLast30d'] as const) {
    if (item[k]?.N !== undefined) out[k] = Number(item[k].N)
  }
  if (Array.isArray(item.recentCalls?.L)) {
    out.recentCalls = item.recentCalls.L.map((v: any) => v.S).filter(Boolean)
  }
  return out
}