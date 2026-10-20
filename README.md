# vapi-call-handler

> **This repo is public** — everything committed here is visible on GitHub.
> No real names, phone numbers, secrets, or other PII may be committed. Real
> data lives only in gitignored local files (`people.yaml`, `local.json`,
> `secrets.json`) and the live AWS/Vapi services.

Routes inbound calls on my personal Vapi number so the assistant knows
who's calling — and eventually what they've talked about before.

- **Phase 1 (this):** webhook answers `assistant-request` with the caller's
  name + which name to use, and archives every
  `end-of-call-report` (transcript + messages) to S3, indexed by person.
- **Phase 3 (not built):** after each call, a summarizer rewrites the
  person's llm notes + follow-ups so the next call can pick up where the
  last left off. Your personal notes are never touched by the LLM.

## People model

The unit of memory is the **person**, not the phone number, because:

- one person can own many numbers (Mom's cell + office), and
- one number can be shared by several people (the rabbi's office line might
  be Ruth or her son; an office line might be the secretary or the
  principal).

DynamoDB tables:

| Table | Key | Meaning |
|---|---|---|
| `People` | `id` (slug, e.g. `maria`) | the profile: name, myName, relationship, personalNotes, llmNotes, followUps, calls, lastCalled |
| `NumberIndex` | `number` (E.164) | incoming number → `people[]` (the people who use that line) |
| `CallIndex` | `callId`, GSI `ByPerson(personId, startedAt)` | one row per call — a person **has many** calls via this GSI. Each row: `startedAt`, `endedAt`, `durationSeconds`, `number`, `cost`, `endedReason`, `llmNotes` (phase 3). `bin/vapi.py calls --person maria` lists them newest first |

S3 (`CallLogs` bucket) is the raw archive: `calls/<YYYY-MM-DD>/<callId>.json`
with the full transcript + message array. CallIndex is the queryable view
over it. S3 is append-only (one PutObject per call, unique key, never
updated); Dynamo does the indexing.

**Phone numbers have people.** A line is just a list of the people who use
it — there is no special "primary" and "the rest." A line with one person
is **personal** (greet by name); a line with more than one is **shared**
(the rabbi's office line might be Ruth or her son; an office line might
be the secretary or the principal). For a shared line the assistant greets
generically (no `{{callerName}}`) and asks who's speaking instead of
assuming — the right behavior when the caller ID can't tell you who picked
up. Post-call (phase 3), the summarizer can attribute the conversation to
the actual speaker.

## Stack

AWS CDK (TypeScript, `aws-cdk-lib`) → us-west-2 (Vapi's docs say to host the
webhook near us-west-2; `assistant-request` must be answered in 7.5s
end-to-end):

- `src/main.ts` / `src/vapi-call-handler.ts` — the CDK app + single
  `VapiCallHandlerStack` (region pinned in the app). Synthesizes the tables,
  bucket, both Lambdas, the stream trigger, and a public Lambda Function URL.
- `functions/api.ts` — the webhook (Lambda with a public Function URL).
  - `assistant-request`: number → NumberIndex → People (one batch read,
    ~10ms) → `assistantOverrides.variableValues`.
  - `end-of-call-report`: archive to S3 + index row in CallIndex (with
    start/end time and duration). Redelivered reports are ignored
    (conditional put).
- `functions/after-call.ts` — the deferred after-call job, fired by the
  CallIndex DynamoDB stream on each new call row. Recomputes the caller's
  call frequency (last 24h / 7d / 30d) from the ByPerson GSI and stores it
  on their People row (`callsLast24h`, `callsLast7d`, `callsLast30d`,
  `recentCalls`, `lastCalled`). The phase-3 summarizer will live here too.
  The webhook re-buckets `recentCalls` against the current time when a call
  comes in, so the counts decay correctly even between calls.
- `lib/vapi.ts` — number extraction (E.164 or `sip:+1...@host`), auth
  guard, timing wrapper (warns at >3.75s of the 7.5s budget).
- `lib/people.ts` — pure resolution logic (file + Dynamo paths), testable.
- `lib/types.ts` — Vapi payload + Person/CallIndexItem/CallLog shapes.
- `people.yaml` (gitignored) — **the source of truth for the database**, an array of
  people (see "Managing the database"). Bundled into the Lambda as the
  webhook's fallback when Dynamo is unreachable.
- `bin/vapi.py` — local CLI (no GUI): people CRUD, line management,
  YAML sync/edit, call queries, Vapi phone-number config.
- `People` + `NumberIndex` + `CallIndex` (Dynamo), `CallLogs` (S3).

## Managing the database (YAML)

`people.yaml` (gitignored — your real data) is the database; `people.example.yaml`
is the committed, fictional sample. Each entry is a person:

```yaml
people:
  - id: maria            # optional; derived from the name when omitted
    name: Maria
    my_name: David     # which name to use when they call
    relationship: mom
    phone_numbers:     # every line they call from
      - "+15550123400"
      - "+15550123401"
    personal_notes: "Loves hearing about the build."   # hand-edited by you; the LLM never touches it
    llm_notes: "Prefers calls in the afternoon."       # maintained by the phase-3 summarizer
    follow_ups: "Ask how the garden is doing."
```

Two notes fields on purpose: `personal_notes` is yours — the LLM is never
allowed to write it — and `llm_notes` is what the phase-3 summarizer
rewrites from call history. `{{callerNotes}}` feeds the prompt all of
personal notes + llm notes + follow-ups.

If two people list the same number it becomes a **shared line**.

Three commands move it to and from live Dynamo:

```sh
bin/vapi.py pull     # live Dynamo  ->  people.yaml   (read current state)
bin/vapi.py sync     # people.yaml  ->  live Dynamo   (authoritative: the
                     #                file wins; people removed from the file
                     #                are deleted, lines rebuilt to match)
bin/vapi.py edit     # pull, open $EDITOR, and commit your edits back
```

`edit` backs the file up first, loads the live data, opens it in `$EDITOR`
(or `$VISUAL`), and on save reconciles back to Dynamo. Quit without saving
(or if the YAML is invalid) and it restores the backup and changes nothing.
`calls`/`lastCalled` are owned by the webhook and the phase-3 summarizer, so
`sync` preserves them and the file doesn't carry them.

`people.yaml` is gitignored, so `pull`/`edit` can't leak real data into
the public repo. The webhook bundles it as its Dynamo-down fallback (or the
sample, on a checkout without one).

## Setup

```sh
npm install
npm install-scripts approve esbuild   # if npm blocked esbuild's postinstall
pip install boto3 requests pyyaml
cp local.json.example local.json       # Vapi number/assistant IDs + fallbackNumber (your cell)
cp secrets.json.example secrets.json   # vapiToken + vapiWebhookSecret (openssl rand -hex 24)
cp people.example.yaml people.yaml     # then replace the sample with your real people
npm run build                          # cdk synth — writes cdk.out/outputs.json
npm run deploy                         # cdk deploy (us-west-2, pinned in the app)
bin/vapi.py sync                 # seed live Dynamo from people.yaml
bin/vapi.py vapi sync            # point the number at the webhook (url read from outputs.json)
```

All three local files are gitignored. `secrets.json` is read by both
the CDK stack (`src/vapi-call-handler.ts` — the webhook secret goes into
the Lambda's environment at deploy) and `bin/vapi.py` (Vapi API token,
and the same webhook secret for `vapi sync`) — no env vars, no cdk
secrets.

`local.json` (gitignored) holds the two Vapi identifiers — your personal
phone number's ID and the Mobile Call Screener assistant ID — from the Vapi
dashboard (Numbers / Assistants pages), plus `fallbackNumber`, where calls
are forwarded if the webhook fails. The CDK stack reads the assistant
ID from it at deploy time; `bin/vapi.py` reads the rest for the
`vapi show` / `vapi sync` commands.

`vapi sync` sets, on the Mobile number only:

- `server.url` + `server.headers["x-vapi-webhook-secret"]` (the only sender
  Vapi trusts; the webhook returns 401 without it)
- `fallbackDestination` → your mobile number, so a failed webhook forwards
  the call instead of dropping it
- `assistantId` stays set as a safety net

## Assistant prompt variables

`assistantOverrides.variableValues` feeds these `{{...}}` slots — the
Mobile Call Screener assistant needs a prompt that references them
(it currently has no instructions; writing them is a phase-1 prerequisite):

- `{{callerName}}` — blank for unknown callers **and shared lines**
- `{{myName}}` — who to represent
- `{{callerRelationship}}` — "mom", "neighbor", ...
- `{{callerNotes}}` — phase 3; empty for now
- `{{callerSharedWith}}` — "Ruth, Noah" for a shared line (everyone who
  uses it); the prompt should say "ask who's speaking" when this is set
- `{{callerCallFrequency}}` — e.g. "2 calls in the last 24 hours, 3 in the
  last week, 5 in the last month"; blank if they haven't called in 30 days.
  Also as numbers: `{{callerCallsLast24h}}`, `{{callerCallsLast7d}}`,
  `{{callerCallsLast30d}}`. Lets the assistant notice "you've been calling a
  lot lately".

## Behavior / fallbacks

- Unknown caller → empty variables; the assistant treats them as a
  stranger (wording lives in the prompt).
- Shared line → `callerSharedWith` names the candidates; the assistant
  asks rather than assumes.
- Webhook down or slow → Vapi uses the number's `assistantId` (current
  static assistant), or if even that fails the `fallbackDestination`
  forwards the call to my phone.
- Every call, whether handled or not, lands in S3 + CallIndex (the
  end-of-call-report path re-resolves the person, so the index is
  person-keyed even for calls that took the fallback path).

## Ops

Manage people via the YAML file (the primary way) or ad-hoc commands:

```sh
bin/vapi.py edit                       # pull -> $EDITOR -> commit back
bin/vapi.py pull                       # live Dynamo -> people.yaml
bin/vapi.py sync                       # people.yaml -> live Dynamo
bin/vapi.py people                     # list everyone + their lines
bin/vapi.py line show +15550123403     # who uses this line
# ad-hoc (writes Dynamo directly; a later `pull`/`edit` picks it up):
bin/vapi.py add Sophie --my-name John --relationship aunt --number +1555...
bin/vapi.py line add  +15550123403 ruth noah   # make a line shared
bin/vapi.py calls --days 7            # recent calls
bin/vapi.py calls --person maria        # everything we've discussed with maria
bin/vapi.py call <callId>             # full archive (transcript + messages)
cat cdk.out/outputs.json           # Function URL, table/bucket names (written by synth)
```

Tests: `npx vitest run` (no AWS needed — pure resolution logic only).

## Phases

- [ ] Phase 1: write assistant instructions with the `{{...}}` slots
      (dashboard or via Vapi API); test calls from an unknown, a known,
      and (eventually) a shared line; verify S3 + CallIndex.
- [ ] Phase 3: `end-of-call-report` → SQS → summarizer Lambda (LLM writes
      the call's `CallIndex.llmNotes`, then rewrites `People.llmNotes`/
      `followUps` — never `personalNotes`) → `{{callerNotes}}`.
