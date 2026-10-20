import * as fs from 'node:fs'
import * as path from 'node:path'
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'

// Gitignored per-machine files, same pair the old SST config read:
//   local.json   — Vapi assistant id + fallback number
//   secrets.json — vapiToken + vapiWebhookSecret
// bin/vapi.py reads the same two files, so there's one source for each value.
function readJson(name: string): any {
  const file = path.join(process.cwd(), name)
  if (!fs.existsSync(file)) {
    throw new Error(`${name} is missing — copy ${name}.example and fill it in`)
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// One lowercase name prefix for all physical resource names (S3 bucket
// names must be lowercase; Dynamo table names are case-insensitive).
const NAME = 'vapi-call-handler'
const repoRoot = process.cwd()

export class VapiCallHandlerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // ------------------------------------------------------------- data
    // People: the unit of memory. Keyed by slug (e.g. "maria").
    const people = new dynamodb.Table(this, 'People', {
      tableName: `${NAME}-people`,
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // personal infra
    })

    // Incoming number -> person, for the 7.5s assistant-request path.
    const numberIndex = new dynamodb.Table(this, 'NumberIndex', {
      tableName: `${NAME}-number-index`,
      partitionKey: { name: 'number', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // One row per call: the queryable view over the S3 archive.
    // ByPerson(personId, startedAt) answers "what's new since X last called?"
    // newest-first — the pick-up-where-we-left-off query.
    // The stream drives the deferred after-call job (call frequency now,
    // the phase-3 summarizer later).
    const callIndex = new dynamodb.Table(this, 'CallIndex', {
      tableName: `${NAME}-call-index`,
      partitionKey: { name: 'callId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })
    callIndex.addGlobalSecondaryIndex({
      indexName: 'ByPerson',
      partitionKey: { name: 'personId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'startedAt', type: dynamodb.AttributeType.STRING },
    })

    // Raw call archive: one JSON file per call (transcript + full messages).
    const callLogs = new s3.Bucket(this, 'CallLogs', {
      bucketName: `${NAME}-call-logs`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------ webhook
    // The handlers ship as pre-bundled single-file CJS assets
    // (scripts/bundle.mjs, run by the CDK app before synth) so the
    // deployed payload is exactly what's in lambda-dist/.
    const local = readJson('local.json')
    const secrets = readJson('secrets.json')
    if (!secrets.vapiWebhookSecret) throw new Error('secrets.json needs vapiWebhookSecret')

    const webhook = new lambda.Function(this, 'Webhook', {
      functionName: `${NAME}-webhook`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(repoRoot, 'lambda-dist/webhook')),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(10),
      description: 'Vapi webhook: caller resolution (assistant-request) + call archive/index',
      environment: {
        ASSISTANT_ID: local.vapiAssistantId, // Mobile Call Screener
        VAPI_WEBHOOK_SECRET: secrets.vapiWebhookSecret,
        VAPI_PEOPLE_TABLE: people.tableName,
        VAPI_NUMBER_INDEX_TABLE: numberIndex.tableName,
        VAPI_CALL_INDEX_TABLE: callIndex.tableName,
        VAPI_CALL_LOGS_BUCKET: callLogs.bucketName,
      },
    })
    people.grantReadWriteData(webhook)
    numberIndex.grantReadWriteData(webhook)
    callIndex.grantReadWriteData(webhook)
    callLogs.grantPut(webhook)

    // Public HTTPS endpoint. Auth is done inside the handler via the
    // x-vapi-webhook-secret shared secret (Vapi can't do signed webhooks
    // beyond this; see bin/vapi.py vapi sync).
    const fnUrl = webhook.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE })

    // --------------------------------------------- deferred after-call job
    // One invocation per batch of NEW call rows (INSERT only — the webhook's
    // conditional put means a redelivered report never re-fires it).
    const afterCall = new lambda.Function(this, 'AfterCall', {
      functionName: `${NAME}-after-call`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(repoRoot, 'lambda-dist/after-call')),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      description: 'Deferred after-call job: recomputes call frequency from the CallIndex stream',
      environment: {
        VAPI_PEOPLE_TABLE: people.tableName,
        VAPI_CALL_INDEX_TABLE: callIndex.tableName,
      },
    })
    people.grantReadWriteData(afterCall)
    callIndex.grantReadData(afterCall)
    afterCall.addEventSource(
      new DynamoEventSource(callIndex, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 10,
        // No ESM-level event filter: this build's L1 FilterProperty can't carry
        // the nested { dynamodb: { eventName } } shape (it renders to `{}`), and
        // it's redundant anyway — personIdsFromStream() skips any record that
        // isn't an INSERT, so MODIFY/REMOVE rows never trigger a frequency
        // recompute.
      })
    )

    // ------------------------------------------------------------ outputs
    // Read back from the deployed CloudFormation stack by bin/vapi.py.
    new cdk.CfnOutput(this, 'OutUrl', { value: fnUrl.url })
    new cdk.CfnOutput(this, 'OutPeople', { value: people.tableName })
    new cdk.CfnOutput(this, 'OutNumberIndex', { value: numberIndex.tableName })
    new cdk.CfnOutput(this, 'OutCallIndex', { value: callIndex.tableName })
    new cdk.CfnOutput(this, 'OutCallLogs', { value: callLogs.bucketName })
  }
}
