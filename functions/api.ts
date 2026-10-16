import {
  DynamoDBClient,
  BatchGetItemCommand,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { authGuard, timingMiddleware, extractCallerNumber } from '../lib/vapi'
import { loadPeopleFile, resolveFromPeopleFile, fromPersonDynamo } from '../lib/people'
import type { Resolution } from '../lib/people'
import type {
  AssistantRequestPayload,
  EndOfCallReportPayload,
  CallLog,
  People,
  Person,
} from '../lib/types'

const ddb = new DynamoDBClient({})
const s3 = new S3Client({})

// No caller to resolve to (missing number, or a line nobody's mapped).
const EMPTY_RESOLUTION: Resolution = { personIds: [], person: null }

// ---------------------------------------------------------------- resolution

// Resolve an incoming number to the people on that line: Dynamo first
// (NumberIndex row + the People rows in one batch), contacts.json as the
// fallback (and the live source until `bin/vapi.py sync-contacts`).
async function resolveCaller(number: string): Promise<Resolution> {
  try {
    const numberRow = await ddb
      .send(new GetItemCommand({
        TableName: process.env.SST_NumberIndex_TableName!,
        Key: { number: { S: number } },
      }))
      .then((r) => r.Item)
    if (numberRow) {
      const personIds: string[] = (numberRow.people?.L ?? []).map((v: any) => v.S)
      const peopleRows = await fetchPeople(personIds)
      // A personal line carries its single profile; shared lines don't.
      const person = personIds.length === 1 ? peopleRows[personIds[0]] ?? null : null
      return { personIds, person }
    }
  } catch (err) {
    console.error('Dynamo lookup failed, using contacts.json:', err)
  }
  const file = await loadPeopleFile()
  return resolveFromPeopleFile(file, number)
}

async function fetchPeople(ids: string[]): Promise<Record<string, Person | undefined>> {
  const out: Record<string, Person | undefined> = {}
  if (!ids.length) return out
  try {
    const res = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [process.env.SST_People_TableName!]: {
            Keys: ids.map((id) => ({ id: { S: id } })),
          },
        },
      })
    )
    for (const it of res.Responses?.[process.env.SST_People_TableName!] ?? []) {
      const id = (it as any).id?.S
      if (id) out[id] = fromPersonDynamo(it)
    }
  } catch (err) {
    console.error('people batch read failed, falling back to contacts.json:', err)
    throw err
  }
  return out
}

interface PromptContext {
  callerName: string
  myName: string
  callerRelationship: string
  callerNotes: string
  callerSharedWith: string
}

// What the assistant prompt sees. Three cases, intentionally distinct:
//   - unknown line  -> no name at all
//   - personal line -> the person's name, relationship, and notes
//   - shared line   -> no name; callerSharedWith lists who it might be, and
//                      the prompt is told to ask, not assume.
async function toPromptContext(res: Resolution): Promise<PromptContext> {
  if (res.personIds.length === 0) {
    return { callerName: '', myName: 'Chris', callerRelationship: '', callerNotes: '', callerSharedWith: '' }
  }
  if (res.personIds.length === 1 && res.person) {
    const p = res.person
    return {
      callerName: p.name ?? '',
      myName: p.myName ?? 'Chris',
      callerRelationship: p.relationship ?? '',
      callerNotes: [p.profile, p.followUps].filter(Boolean).join(' '),
      callerSharedWith: '',
    }
  }
  // Shared line: we don't know who's speaking, so greet generically (default
  // name) and hand the prompt the list of possible callers.
  const names = await namesFor(res.personIds)
  return {
    callerName: '',
    myName: 'Chris',
    callerRelationship: '',
    callerNotes: '',
    callerSharedWith: res.personIds.map((id) => names[id]).join(', '),
  }
}

// Resolve display names for a set of person slugs. Bundled file first, Dynamo
// for anyone added via the CLI. Returns slug -> name (missing -> slug).
async function namesFor(ids: string[]): Promise<Record<string, string>> {
  const file = await loadPeopleFile().catch(() => ({} as People))
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const id of ids) {
    const n = file[id]?.name
    if (n) out[id] = n
    else missing.push(id)
  }
  if (missing.length) {
    try {
      const res = await ddb.send(
        new BatchGetItemCommand({
          RequestItems: {
            [process.env.SST_People_TableName!]: {
              Keys: missing.map((id) => ({ id: { S: id } })),
            },
          },
        })
      )
      for (const it of (res.Responses?.[process.env.SST_People_TableName!] ?? [])) {
        const id = (it as any).id?.S
        const name = (it as any).name?.S
        if (id && name) out[id] = name
      }
    } catch (err) {
      console.error('name lookup failed, using slugs:', err)
    }
  }
  for (const id of ids) if (!out[id]) out[id] = id
  return out
}

// ---------------------------------------------------------------- call log

async function storeCallReport(payload: EndOfCallReportPayload, res: Resolution) {
  const { call, artifact } = payload.message
  const date = (call.startedAt ?? new Date().toISOString()).slice(0, 10)
  const myName = res.person?.myName ?? 'Chris'
  // The one person we're sure this was: the person on a personal line.
  // Shared and unknown lines have no single owner (phase 3 may attribute it).
  const owner = res.personIds.length === 1 ? res.personIds[0] : ''

  const log: CallLog = {
    callId: call.id,
    date,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    endedReason: payload.message.endedReason,
    cost: payload.message.cost,
    personId: owner,
    personIds: res.personIds,
    callerNumber: call.customer?.number,
    callerName: call.customer?.name,
    myName,
    transcript: artifact?.transcript,
    messages: artifact?.messages as Array<Record<string, unknown>> | undefined,
    recordingUrl: artifact?.recordingUrl,
  }
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: process.env.SST_CallLogs_BucketName!,
        Key: `calls/${date}/${call.id}.json`,
        Body: JSON.stringify(log, null, 2),
        ContentType: 'application/json',
      })
    )
  } catch (err) {
    console.error('failed to store S3 call log:', err)
  }

  // Queryable index row. PutItem by callId is idempotent — a redelivered
  // report just overwrites with the same data. personId: the person on a
  // personal line, 'shared' for shared lines, 'unknown' otherwise — so
  // `calls --person shared` lists shared-line calls until phase 3 attributes
  // them to a real person.
  const indexedPersonId = res.personIds.length === 1 ? res.personIds[0] : (res.personIds.length > 1 ? 'shared' : 'unknown')
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: process.env.SST_CallIndex_TableName!,
        Item: {
          callId: { S: call.id },
          personId: { S: indexedPersonId },
          ...(res.personIds.length > 1 ? { personIds: { L: res.personIds.map((id) => ({ S: id })) } } : {}),
          number: { S: call.customer?.number ?? '' },
          startedAt: { S: call.startedAt ?? new Date().toISOString() },
          ...(payload.message.endedReason ? { endedReason: { S: payload.message.endedReason } } : {}),
          ...(typeof payload.message.cost === 'number' ? { cost: { N: String(payload.message.cost) } } : {}),
        },
      })
    )
    console.info('call indexed', { callId: call.id, personId: indexedPersonId })
  } catch (err) {
    console.error('failed to store CallIndex row:', err)
  }
}

// ---------------------------------------------------------------- handler

export const handler = authGuard(
  timingMiddleware(async (event: any) => {
    const payload = event as AssistantRequestPayload | EndOfCallReportPayload
    const type = payload?.message?.type
    const started = Date.now()

    if (type === 'assistant-request') {
      const number = extractCallerNumber(payload as AssistantRequestPayload)
      const res = number ? await resolveCaller(number) : EMPTY_RESOLUTION
      const ctx = await toPromptContext(res)
      console.info('assistant-request', {
        number,
        personIds: res.personIds,
        shared: res.personIds.length > 1,
        ms: Date.now() - started,
      })
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: process.env.ASSISTANT_ID,
          assistantOverrides: {
            variableValues: ctx,
          },
        }),
      }
    }

    if (type === 'end-of-call-report') {
      const ep = payload as EndOfCallReportPayload
      const number = extractCallerNumber({
        message: { type: 'assistant-request', call: ep.message.call },
      })
      const res = number ? await resolveCaller(number) : EMPTY_RESOLUTION
      await storeCallReport(ep, res)
      // Phase 3: summarizer (triggered from here) reads the S3 file, rewrites
      // People.profile/followUps, and backfills CallIndex.summary.
      console.info('end-of-call-report acknowledged', {
        callId: ep.message.call.id,
        personIds: res.personIds,
        ms: Date.now() - started,
      })
      return { statusCode: 200, body: JSON.stringify({}) }
    }

    // Everything else in phase 1: transcript, status-update, tool-calls for
    // the transfer/endCall tools, etc. — acknowledge so Vapi doesn't retry.
    console.info('event not handled in phase 1:', type)
    return { statusCode: 200, body: JSON.stringify({}) }
  })
)