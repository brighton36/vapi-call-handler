/// <reference path="./.sst/platform/config.d.ts" />
import { readFileSync } from 'node:fs'
import path from 'node:path'

// Phase 1: one API (the Vapi Server URL), one Dynamo table (callers), one S3
// bucket (call logs). All in us-west-2 — Vapi's docs tell you to host the
// assistant-request webhook close to us-west-2 (7.5s hard limit on the reply).

export default $config({
  app() {
    return {
      name: 'vapi-call-handler',
      home: 'aws',
      region: 'us-west-2',
      removal: 'remove', // personal infra; flip to 'retain' before real traffic matters
      protect: false,
    }
  },
  async run() {
    $transform(sst.aws.Function, (input) => {
      input.runtime = 'nodejs24.x'
    })

    const secret = new sst.Secret('VapiWebhookSecret')

    // People: the unit of memory. Keyed by slug (e.g. "maria").
    const people = new sst.aws.Dynamo('People', {
      fields: { id: 'string' },
      primaryIndex: { hashKey: 'id' },
    })

    // Incoming number -> person, for the 7.5s assistant-request path.
    // sharedWith: other people who sometimes call from this line (shared
    // office phones etc.) — the assistant asks instead of assuming.
    const numberIndex = new sst.aws.Dynamo('NumberIndex', {
      fields: { number: 'string' },
      primaryIndex: { hashKey: 'number' },
    })

    // One row per call: the queryable view over the S3 archive.
    // ByPerson(personId, startedAt) answers "what's new since X last called?"
    // newest-first, which is the pick-up-where-we-left-off query.
    const callIndex = new sst.aws.Dynamo('CallIndex', {
      fields: { callId: 'string', personId: 'string', startedAt: 'string' },
      primaryIndex: { hashKey: 'callId' },
      globalIndexes: {
        ByPerson: { hashKey: 'personId', rangeKey: 'startedAt' },
      },
    })

    // Raw call archive: one JSON file per call (transcript + full messages).
    const callLogs = new sst.aws.Bucket('CallLogs')

    // Phase 3 will add: end-of-call report -> SQS -> summarizer Lambda ->
    // LLM (Bedrock or OpenAI) rewrites callers.notes.

    // Per-machine Vapi identifiers (the number + assistant GUIDs) live in
    // gitignored local.json — see local.json.example.
    const local = JSON.parse(readFileSync(path.join(process.cwd(), 'local.json'), 'utf8'))

    const fn = new sst.aws.Function('Webhook', {
      handler: 'functions/api.handler',
      environment: {
        ASSISTANT_ID: local.vapiAssistantId, // Mobile Call Screener
        VAPI_WEBHOOK_SECRET: secret.value,
      },
      link: [people, numberIndex, callIndex, callLogs],
      copyFiles: [{ from: 'people.yaml' }],
      // Public HTTPS endpoint — auth is done inside the handler via the
      // x-vapi-webhook-secret shared secret (Vapi can't do signed webhooks
      // beyond this; see bin/vapi.py vapi sync).
      url: { authorization: 'none' },
    })

    new sst.Secret('VapiToken') // used only by the local bin/ scripts
    return { api: fn }
  },
  console: {
    autodeploy: {
      target(event) {
        if (event.type === 'branch' && event.branch === 'master' && event.action === 'pushed') {
          return { stage: 'production' }
        }
      },
      async workflow({ $ }) {
        await $`npm ci --verbose`
      },
    },
  },
})