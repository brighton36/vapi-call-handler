import {
  DynamoDBClient,
  BatchGetItemCommand,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { authGuard, timingMiddleware, extractCallerNumber, callDurationSeconds, parseWebhookBody } from '../lib/vapi'
import { computeFrequency, describeFrequency } from '../lib/frequency'
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

// Resource names come from the function's environment — the CDK stack
// (src/vapi-call-handler.ts) exports them at deploy, so nothing here
// hardcodes a table or bucket name.
const PEOPLE_TABLE = process.env.VAPI_PEOPLE_TABLE!
const NUMBER_INDEX_TABLE = process.env.VAPI_NUMBER_INDEX_TABLE!
const CALL_INDEX_TABLE = process.env.VAPI_CALL_INDEX_TABLE!
const CALL_LOGS_BUCKET = process.env.VAPI_CALL_LOGS_BUCKET!

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
        TableName: NUMBER_INDEX_TABLE,
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
          [PEOPLE_TABLE]: {
            Keys: ids.map((id) => ({ id: { S: id } })),
          },
        },
      })
    )
    for (const it of res.Responses?.[PEOPLE_TABLE] ?? []) {
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
  // How often they've called lately, e.g. "2 calls in the last 24 hours, 3 in
  // the last week, 5 in the last month". '' = no calls in 30 days / unknown.
  callerCallFrequency: string
  callerCallsLast24h: number
  callerCallsLast7d: number
  callerCallsLast30d: number
}

const NO_FREQUENCY = { callerCallFrequency: '', callerCallsLast24h: 0, callerCallsLast7d: 0, callerCallsLast30d: 0 }

// Frequency is computed by the deferred after-call job (recentCalls on the
// People row). Re-bucket those stored timestamps against now so the counts
// stay right even if the person hasn't called since — no extra read.
function frequencyContext(recentCalls: string[] | undefined, now = new Date()) {
  const f = computeFrequency(recentCalls ?? [], now)
  return {
    callerCallFrequency: describeFrequency(f),
    callerCallsLast24h: f.callsLast24h,
    callerCallsLast7d: f.callsLast7d,
    callerCallsLast30d: f.callsLast30d,
  }
}

// What the assistant prompt sees. Three cases, intentionally distinct:
//   - unknown line  -> no name at all
//   - personal line -> the person's name, relationship, and notes
//   - shared line   -> no name; callerSharedWith lists who it might be, and
//                      the prompt is told to ask, not assume.
async function toPromptContext(res: Resolution): Promise<PromptContext> {
  if (res.personIds.length === 0) {
    return { callerName: '', myName: 'Chris', callerRelationship: '', callerNotes: '', callerSharedWith: '', ...NO_FREQUENCY }
  }
  if (res.personIds.length === 1 && res.person) {
    const p = res.person
    return {
      callerName: p.name ?? '',
      myName: p.myName ?? 'Chris',
      callerRelationship: p.relationship ?? '',
      callerNotes: [p.personalNotes, p.llmNotes, p.followUps].filter(Boolean).join(' '),
      callerSharedWith: '',
      ...frequencyContext('recentCalls' in p ? p.recentCalls : undefined),
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
    ...NO_FREQUENCY,
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
            [PEOPLE_TABLE]: {
              Keys: missing.map((id) => ({ id: { S: id } })),
            },
          },
        })
      )
      for (const it of (res.Responses?.[PEOPLE_TABLE] ?? [])) {
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
        Bucket: CALL_LOGS_BUCKET,
        Key: `calls/${date}/${call.id}.json`,
        Body: JSON.stringify(log, null, 2),
        ContentType: 'application/json',
      })
    )
  } catch (err) {
    console.error('failed to store S3 call log:', err)
  }

  // Queryable index row. The INSERT also fires the deferred after-call job
  // (CallIndex stream -> functions/after-call.ts), which recomputes the
  // person's call frequency. personId: the person on a
  // personal line, 'shared' for shared lines, 'unknown' otherwise — so
  // `calls --person shared` lists shared-line calls until phase 3 attributes
  // them to a real person.
  const indexedPersonId = res.personIds.length === 1 ? res.personIds[0] : (res.personIds.length > 1 ? 'shared' : 'unknown')
  const startedAt = call.startedAt ?? new Date().toISOString()
  const duration = callDurationSeconds(call.startedAt, call.endedAt)
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: CALL_INDEX_TABLE,
        Item: {
          callId: { S: call.id },
          personId: { S: indexedPersonId },
          ...(res.personIds.length > 1 ? { personIds: { L: res.personIds.map((id) => ({ S: id })) } } : {}),
          number: { S: call.customer?.number ?? '' },
          startedAt: { S: startedAt },
          ...(call.endedAt ? { endedAt: { S: call.endedAt } } : {}),
          ...(duration !== undefined ? { durationSeconds: { N: String(duration) } } : {}),
          ...(payload.message.endedReason ? { endedReason: { S: payload.message.endedReason } } : {}),
          ...(typeof payload.message.cost === 'number' ? { cost: { N: String(payload.message.cost) } } : {}),
          // llmNotes: written later by the phase-3 summarizer.
        },
        // Only the first delivery creates the row, so a redelivered report
        // doesn't re-fire the after-call job.
        ConditionExpression: 'attribute_not_exists(callId)',
      })
    )
    console.info('call indexed', { callId: call.id, personId: indexedPersonId })
  } catch (err: any) {
    if (err?.name === 'ConditionalCheckFailedException') {
      console.info('call already indexed (redelivery)', { callId: call.id })
      return
    }
    console.error('failed to store CallIndex row:', err)
    return
  }

}

// ---------------------------------------------------------------- handler

export const handler = authGuard(
  timingMiddleware(async (event: any) => {
    // Function URL events carry the Vapi JSON as a (maybe base64) string body.
    const payload = parseWebhookBody(event) as AssistantRequestPayload | EndOfCallReportPayload
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
      // Deferred work (frequency now; phase-3 summarizer later) runs off the
      // CallIndex stream in functions/after-call.ts — not on this path.
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