// Shared shapes for Vapi webhooks + our Dynamo/S3 records.
// Vapi event reference: https://docs.vapi.ai/server-url/events

export interface VapiServerMessage {
  type: string
  call?: VapiCall
  endedReason?: string
  cost?: number
  artifact?: {
    transcript?: string
    messages?: Array<{ role: string; message: string }>
    recordingUrl?: string
  }
  [key: string]: unknown
}

export interface VapiCall {
  id: string
  type?: string
  status?: string
  customer?: {
    number?: string
    name?: string
    sipUri?: string
    [key: string]: unknown
  }
  phoneNumber?: {
    number?: string
    name?: string
  }
  startedAt?: string
  endedAt?: string
  [key: string]: unknown
}

export interface AssistantRequestPayload {
  message: { type: 'assistant-request'; call: VapiCall }
}

export interface EndOfCallReportPayload {
  message: {
    type: 'end-of-call-report'
    endedReason?: string
    cost?: number
    call: VapiCall
    artifact?: {
      transcript?: string
      messages?: Array<{ role: string; message: string }>
      recordingUrl?: string
    }
  }
}

// ---------------------------------------------------------------- people model
//
// The unit of memory is the PERSON, not the phone number:
//   - one person can own many numbers (Mom's cell + office)
//   - one number can be shared by several people (Ruth + her son)
//
// Dynamo tables:
//   People        hash: id (slug, e.g. "maria")                        -> profile
//   NumberIndex   hash: number (E.164)                               -> people[] (1 = personal, >1 = shared)
//   CallIndex     hash: callId, GSI ByPerson(personId, startedAt)    -> per-call row
//
// S3 (CallLogs bucket) is the raw archive: one JSON file per call.
// CallIndex rows are the queryable view over it.

export interface Person {
  // slug, e.g. "maria"
  id: string
  name?: string
  // Which name to call Chris when this person calls: "Chris" or "David".
  myName?: string
  relationship?: string
  // Phase 3: LLM-maintained profile of who they are + durable topics.
  profile?: string
  // Phase 3: things to raise next time ("ask how Milo's vet visit went").
  followUps?: string
  calls?: number
  lastCalled?: string
}

export interface NumberIndexItem {
  number: string
  // Everyone who calls from this line. Length 1 = a personal line (greet by
  // name); length > 1 = a shared line (greet generically, ask who's speaking).
  people: string[]
}

export interface CallIndexItem {
  callId: string
  // The one person we're sure this was ('unknown' for unknown lines, or for
  // shared lines until phase 3 attributes the call).
  personId: string
  // Everyone who uses the calling line (present for shared lines).
  personIds?: string[]
  number: string
  // ISO timestamp — GSI range key, so lex order = chronological order.
  startedAt: string
  endedReason?: string
  cost?: number
  // Phase 3: one-line summary of the call.
  summary?: string
}

// One call, archived to S3 as calls/<YYYY-MM-DD>/<callId>.json
export interface CallLog {
  callId: string
  date: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  cost?: number
  // The one person we're sure this was ('' for unknown or shared lines).
  personId: string
  // Everyone who uses the calling line (present for shared lines).
  personIds?: string[]
  callerNumber?: string
  callerName?: string
  // Who the assistant is "talking as" on this call.
  myName?: string
  // The transcript exactly as Vapi returned it.
  transcript?: string
  // Full message array (every turn, with timing).
  messages?: Array<Record<string, unknown>>
  recordingUrl?: string
}

// ---------------------------------------------------------------- contacts.json
// The in-repo seed / fallback, keyed by person slug.
export interface PersonFileEntry {
  name: string
  myName: string
  relationship?: string
  // Every line this person calls from.
  numbers: string[]
}

export type People = Record<string, PersonFileEntry>