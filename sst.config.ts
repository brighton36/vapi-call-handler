/// <reference path="./.sst/platform/config.d.ts" />

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

    // SST forbids top-level imports in this file, so node modules load here.
    const { readFileSync, existsSync } = await import('node:fs')
    const path = await import('node:path')
    const readJson = (name: string) => {
      const file = path.join(process.cwd(), name)
      if (!existsSync(file)) throw new Error(`${name} is missing — copy ${name}.example and fill it in`)
      return JSON.parse(readFileSync(file, 'utf8'))
    }
    // Gitignored per-machine files: local.json (Vapi IDs, fallback number)
    // and secrets.json (Vapi token + webhook secret). bin/vapi.py reads the
    // same two files, so there's one source for each value.
    const local = readJson('local.json')
    const secrets = readJson('secrets.json')
    if (!secrets.vapiWebhookSecret) throw new Error('secrets.json needs vapiWebhookSecret')

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
    // The stream drives the deferred after-call job (call frequency now,
    // the phase-3 summarizer later).
    const callIndex = new sst.aws.Dynamo('CallIndex', {
      fields: { callId: 'string', personId: 'string', startedAt: 'string' },
      primaryIndex: { hashKey: 'callId' },
      globalIndexes: {
        ByPerson: { hashKey: 'personId', rangeKey: 'startedAt' },
      },
      stream: 'new-image',
    })

    // Raw call archive: one JSON file per call (transcript + full messages).
    const callLogs = new sst.aws.Bucket('CallLogs')

    // The real people.yaml is gitignored (PII); fall back to the committed
    // sample so a fresh checkout still deploys. Bundled as the webhook's
    // Dynamo-down fallback.
    const peopleFile = existsSync(path.join(process.cwd(), 'people.yaml')) ? 'people.yaml' : 'people.example.yaml'

    const fn = new sst.aws.Function('Webhook', {
      handler: 'functions/api.handler',
      environment: {
        ASSISTANT_ID: local.vapiAssistantId, // Mobile Call Screener
        VAPI_WEBHOOK_SECRET: secrets.vapiWebhookSecret,
      },
      link: [people, numberIndex, callIndex, callLogs],
      copyFiles: [{ from: peopleFile, to: 'people.yaml' }],
      // Public HTTPS endpoint — auth is done inside the handler via the
      // x-vapi-webhook-secret shared secret (Vapi can't do signed webhooks
      // beyond this; see bin/vapi.py vapi sync).
      url: { authorization: 'none' },
    })

    // Deferred after-call job: one invocation per batch of NEW call rows.
    // Recomputes the caller's 24h / 7d / 30d call frequency onto People.
    callIndex.subscribe(
      'AfterCall',
      {
        handler: 'functions/after-call.handler',
        link: [people, callIndex],
        timeout: '30 seconds',
      },
      {
        filters: [{ eventName: ['INSERT'] }],
      },
    )

    // Written to .sst/outputs.json on deploy; bin/vapi.py reads it (SST v4
    // has no `sst output` command).
    return {
      url: fn.url,
      People: people.name,
      NumberIndex: numberIndex.name,
      CallIndex: callIndex.name,
      CallLogs: callLogs.name,
    }
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