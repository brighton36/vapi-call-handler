import { load } from 'js-yaml'
import type { People, PersonFileEntry, Person } from './types'

// The resolved profile for a personal line. From the file it's a full
// PersonFileEntry; from Dynamo it's a Person (no `numbers`). Union of both.
export type ResolvedPerson = (PersonFileEntry & Partial<Pick<Person, 'profile' | 'followUps'>>)
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
  name: string
  my_name?: string
  relationship?: string
  phone_numbers?: string[]
  notes?: string
  follow_ups?: string
}

// Parse people.yaml text into the slug -> entry map the rest of the code uses.
// `id` falls back to a slug derived from the name. Two people listing the same
// number both end up with it in `numbers` — shared-line detection is a
// property of the resolved list, not of the file.
export function parsePeopleYaml(text: string): People {
  if (!text || !text.trim()) return {}
  const doc = (load(text) ?? {}) as { people?: YamlPerson[] }
  const out: People = {}
  for (const p of doc.people ?? []) {
    if (!p || typeof p.name !== 'string') continue
    const slug = p.id ?? slugify(p.name)
    out[slug] = {
      name: p.name,
      myName: p.my_name ?? 'Chris',
      relationship: p.relationship,
      numbers: p.phone_numbers ?? [],
    }
  }
  return out
}

// The in-repo seed + fallback, bundled into the Lambda. Dynamo is the live
// source; this file is what the webhook falls back to when Dynamo is down.
// people.yaml is copied to the function bundle root (SST copyFiles). We probe
// a few candidate locations (cwd, and the directory this module lives in) so
// it works whether cwd is the bundle root or the repo root. A missing or
// unparseable file yields {} (treat everyone as unknown) rather than throwing
// — a bad file must never drop a call.
export async function loadPeopleFile(): Promise<People> {
  try {
    const { readFileSync, existsSync } = await import('node:fs')
    const { cwd } = await import('node:process')
    const { dirname, join } = await import('node:path')
    // import.meta.url is the bundled module; its directory is the bundle root.
    const here = dirname(new URL(import.meta.url).pathname)
    const candidates = [join(cwd(), 'people.yaml'), join(here, 'people.yaml'), join(here, '..', 'people.yaml')]
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
  for (const k of ['name', 'myName', 'relationship', 'profile', 'followUps', 'lastCalled']) {
    if (item[k]?.S !== undefined) (out as any)[k] = item[k].S
  }
  if (item.calls?.N !== undefined) out.calls = Number(item.calls.N)
  return out
}