// Pre-bundles the two Lambda handlers into plain-CJS single files that the
// CDK stack ships as code assets. Bundling here (instead of via a
// NodejsFunction) keeps the deployed asset fully predictable: one
// index.cjs per function plus, for the webhook, the people.yaml fallback.
// Run via `npm run bundle` (also invoked by `npm run build`).
import { build } from 'esbuild'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const repoRoot = process.cwd()
const targets = [
  { entry: 'functions/api.ts', dir: 'lambda-dist/webhook' },
  { entry: 'functions/after-call.ts', dir: 'lambda-dist/after-call' },
]

for (const t of targets) {
  const outdir = join(repoRoot, t.dir)
  mkdirSync(outdir, { recursive: true })
  await build({
    entryPoints: [join(repoRoot, t.entry)],
    outfile: join(outdir, 'index.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    logLevel: 'warning',
  })
  console.log(`bundled ${t.entry} -> ${t.dir}/index.cjs`)
}

// The webhook's Dynamo-down fallback, at the bundle root (SST copyFiles
// equivalent). Real people.yaml when present, the committed sample otherwise.
const peopleFile = existsSync(join(repoRoot, 'people.yaml')) ? 'people.yaml' : 'people.example.yaml'
copyFileSync(join(repoRoot, peopleFile), join(repoRoot, 'lambda-dist/webhook/people.yaml'))
console.log(`bundled people fallback -> lambda-dist/webhook/people.yaml (from ${peopleFile})`)
