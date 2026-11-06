#!/usr/bin/env node
// US01 acceptance: no secrets in client assets (ai.md §1 invariant 8, §14).
// Scans the built web bundle for server-only env names and secret-shaped strings.
// Usage: node scripts/check-bundle-secrets.mjs [distDir]   (default apps/web/dist)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const dist = resolve(process.argv[2] ?? 'apps/web/dist')
if (!existsSync(dist)) {
  console.error(`No build found at ${dist}. Run "npm run build" first.`)
  process.exit(2)
}

const SERVER_ONLY_NAMES = [
  'DATABASE_URL',
  'DATABASE_CA_CERT',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'SESSION_HMAC_SECRET',
]

const PATTERNS = [
  { name: 'JWT', regex: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: 'Google API key', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { name: 'Supabase secret key', regex: /sb_secret_[A-Za-z0-9_-]{10,}/ },
  { name: 'Postgres connection string', regex: /postgres(?:ql)?:\/\/[^\s"'`]+:[^\s"'`]+@/ },
  { name: 'Private key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

// Real values of server-only variables present in this environment must never appear either.
const LIVE_VALUES = SERVER_ONLY_NAMES.map((name) => [name, process.env[name]]).filter(
  ([, value]) => typeof value === 'string' && value.length >= 8,
)

function* files(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else yield path
  }
}

const findings = []
let scanned = 0
for (const file of files(dist)) {
  if (!/\.(js|mjs|css|html|json|map|txt|svg)$/.test(file)) continue
  scanned += 1
  const text = readFileSync(file, 'utf8')
  const where = relative(process.cwd(), file)
  for (const name of SERVER_ONLY_NAMES) if (text.includes(name)) findings.push(`${where}: server-only name ${name}`)
  for (const { name, regex } of PATTERNS) if (regex.test(text)) findings.push(`${where}: looks like a ${name}`)
  for (const [name, value] of LIVE_VALUES) if (text.includes(value)) findings.push(`${where}: contains the value of ${name}`)
}

if (findings.length > 0) {
  console.error(`Secret check FAILED (${findings.length} finding(s)):`)
  for (const finding of findings) console.error(`  - ${finding}`)
  process.exit(1)
}
console.log(`Secret check passed: ${scanned} built file(s) in ${relative(process.cwd(), dist) || dist} contain no secrets.`)
