// node scripts/sync-versions.mjs — marketplace entries whose source is a GitHub repo get the version from that repo's
// .claude-plugin/plugin.json (default branch). Prints what changed; writes marketplace.json only when something did.
// Uses GITHUB_TOKEN when set (Actions), otherwise unauthenticated (public repos, 60 requests/hour).
import { readFileSync, writeFileSync } from 'node:fs'

const file = new URL('../.claude-plugin/marketplace.json', import.meta.url)
const text = readFileSync(file, 'utf8')
const market = JSON.parse(text)
const headers = { accept: 'application/vnd.github.raw+json', 'user-agent': 'claude-code-mods-sync' }
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`

let changed = 0
for (const p of market.plugins) {
  if (p.source?.source !== 'github' || !/^[\w.-]+\/[\w.-]+$/.test(p.source.repo || '')) continue
  const res = await fetch(`https://api.github.com/repos/${p.source.repo}/contents/.claude-plugin/plugin.json${p.source.ref ? `?ref=${encodeURIComponent(p.source.ref)}` : ''}`, { headers })
  if (!res.ok) { console.error(`${p.name}: ${res.status} ${res.statusText}`); process.exitCode = 1; continue }
  const v = JSON.parse(await res.text()).version
  if (typeof v !== 'string' || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(v)) { console.error(`${p.name}: bad version ${v}`); process.exitCode = 1; continue }
  if (v === p.version) continue
  console.log(`${p.name} ${p.version} -> ${v}`)
  p.version = v
  changed++
}
if (changed) writeFileSync(file, JSON.stringify(market, null, 2) + (text.endsWith('\n') ? '\n' : ''))
