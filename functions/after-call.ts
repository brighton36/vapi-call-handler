// Deferred after-call job. Triggered by the CallIndex DynamoDB stream: one
// invocation per batch of NEW call rows (INSERT only — the webhook's
// conditional put means a redelivered end-of-call-report never re-fires it).
//
// For each person who just called it recomputes their call frequency from the
// ByPerson GSI (the source of truth, so this is idempotent — a retried batch
// writes the same numbers) and stores it on their People row:
//   callsLast24h, callsLast7d, callsLast30d, recentCalls[], lastCalled
//
// Phase 3's summarizer (CallIndex.llmNotes / People.llmNotes) belongs here
// too. It must NEVER write People.personalNotes.

import { DynamoDBClient, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb'
import { computeFrequency, WINDOW_MS } from '../lib/frequency'

const ddb = new DynamoDBClient({})

// Resource names from the function's environment (set by the CDK stack).
const PEOPLE_TABLE = process.env.VAPI_PEOPLE_TABLE!
const CALL_INDEX_TABLE = process.env.VAPI_CALL_INDEX_TABLE!

// Minimal shape of a DynamoDB stream event (avoids an @types/aws-lambda dep).
interface StreamRecord {
  eventName?: 'INSERT' | 'MODIFY' | 'REMOVE'
  dynamodb?: { NewImage?: Record<string, any> }
}
interface StreamEvent {
  Records?: StreamRecord[]
}

// Pull the person slugs out of a batch of new CallIndex rows. 'unknown' and
// 'shared' rows have no single owner yet (phase 3 attributes shared calls).
export function personIdsFromStream(event: StreamEvent): string[] {
  const ids = new Set<string>()
  for (const r of event.Records ?? []) {
    if (r.eventName !== 'INSERT') continue
    const id = r.dynamodb?.NewImage?.personId?.S
    if (id && id !== 'unknown' && id !== 'shared') ids.add(id)
  }
  return [...ids]
}

async function startedAtsSince(personId: string, sinceIso: string): Promise<string[]> {
  const out: string[] = []
  let ExclusiveStartKey: Record<string, any> | undefined
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: CALL_INDEX_TABLE,
        IndexName: 'ByPerson',
        KeyConditionExpression: 'personId = :p AND startedAt >= :since',
        ExpressionAttributeValues: { ':p': { S: personId }, ':since': { S: sinceIso } },
        ProjectionExpression: 'startedAt',
        ExclusiveStartKey,
      })
    )
    for (const it of r.Items ?? []) if (it.startedAt?.S) out.push(it.startedAt.S)
    ExclusiveStartKey = r.LastEvaluatedKey
  } while (ExclusiveStartKey)
  return out
}

async function refreshFrequency(personId: string, now: Date) {
  const since = new Date(now.getTime() - WINDOW_MS.month).toISOString()
  const f = computeFrequency(await startedAtsSince(personId, since), now)
  const values: Record<string, any> = {
    ':d': { N: String(f.callsLast24h) },
    ':w': { N: String(f.callsLast7d) },
    ':m': { N: String(f.callsLast30d) },
    ':r': { L: f.recentCalls.map((s) => ({ S: s })) },
    ':u': { S: now.toISOString() },
  }
  await ddb.send(
    new UpdateItemCommand({
      TableName: PEOPLE_TABLE,
      Key: { id: { S: personId } },
      UpdateExpression:
        'SET callsLast24h = :d, callsLast7d = :w, callsLast30d = :m, recentCalls = :r, frequencyUpdatedAt = :u',
      // Don't conjure a People row for a slug that's since been removed.
      ConditionExpression: 'attribute_exists(id)',
      ExpressionAttributeValues: values,
    })
  )
  if (f.recentCalls[0]) {
    // Only move lastCalled forward (out-of-order batches can't regress it).
    await ddb
      .send(
        new UpdateItemCommand({
          TableName: PEOPLE_TABLE,
          Key: { id: { S: personId } },
          UpdateExpression: 'SET lastCalled = :last',
          ConditionExpression: 'attribute_exists(id) AND (attribute_not_exists(lastCalled) OR lastCalled < :last)',
          ExpressionAttributeValues: { ':last': { S: f.recentCalls[0] } },
        })
      )
      .catch((err) => {
        if (err?.name !== 'ConditionalCheckFailedException') throw err
      })
  }
  console.info('frequency refreshed', { personId, ...f, recentCalls: f.recentCalls.length })
}

export const handler = async (event: StreamEvent) => {
  const now = new Date()
  for (const personId of personIdsFromStream(event)) {
    try {
      await refreshFrequency(personId, now)
    } catch (err: any) {
      if (err?.name === 'ConditionalCheckFailedException') {
        console.warn('person not found, skipping frequency', { personId })
        continue
      }
      // Throw so Lambda retries the batch (the work is idempotent).
      throw err
    }
  }
}
