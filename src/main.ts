// CDK app entrypoint. The stack is single-environment (us-west-2, Vapi's
// required webhook region), so context is pinned in the app instead of
// relying on the CDK_DEFAULT_* env vars.
import { execFileSync } from 'node:child_process'
import * as cdk from 'aws-cdk-lib'
import { VapiCallHandlerStack } from './vapi-call-handler'

// Bundle the handlers first so the code assets exist before synth.
execFileSync(process.execPath, ['scripts/bundle.mjs'], { cwd: process.cwd(), stdio: 'inherit' })

const app = new cdk.App()
new VapiCallHandlerStack(app, 'VapiCallHandlerStack', {
  env: { region: 'us-west-2' },
  description:
    'Vapi webhook (us-west-2): caller resolution for assistant-request + end-of-call archive/index.',
})

app.synth()
