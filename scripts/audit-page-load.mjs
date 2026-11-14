#!/usr/bin/env node
// Static audit of what every page costs at load. Writes docs/app-context/PAGE_LOAD_AUDIT.generated.md.
//
//   node scripts/audit-page-load.mjs            regenerate the report
//   node scripts/audit-page-load.mjs --check    exit 1 when the committed report is out of date
//
// It READS the source only: it follows each page's imports through the code and counts what it finds
// (database calls, reads with no row limit, "fetch everything" loops, polling, heavy libraries, whether the
// page uses the shared query cache, whether a record page is prepared and cached). It cannot see run time,
// so every number is a pointer to look, not a measurement: measure before and after you change a page.
// The output has no dates and no commit hash, so it only changes when the code does.
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src')
const OUT = path.join(ROOT, 'docs', 'app-context', 'PAGE_LOAD_AUDIT.generated.md')
const EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs']
const HEAVY = ['xlsx', 'pdfkit', 'jspdf', 'html2canvas', 'recharts', 'chart.js', 'framer-motion', 'moment', 'lodash', 'exceljs', 'pdf-lib', 'fflate', 'qrcode.react', 'date-fns', 'jszip', 'pdfjs-dist']

const walk = (d, out = []) => {
  for (const n of fs.readdirSync(d)) {
    const p = path.join(d, n)
    if (fs.statSync(p).isDirectory()) { if (n !== 'node_modules' && n !== '.next') walk(p, out) }
    else if (EXT.includes(path.extname(n)) && !/\.test\.(tsx?|mjs|jsx?)$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p)
  }
  return out
}
const files = walk(SRC).sort()
const fileSet = new Set(files)
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const count = (s, re) => (s.match(re) || []).length

const resolveLocal = (from, spec) => {
  let base
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null
  return [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, 'index' + e))].find((c) => fileSet.has(c)) ?? null
}

const info = new Map()
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  const imports = []
  const externals = new Set()
  const importRe = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^'";]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
  let m
  while ((m = importRe.exec(s))) {
    if (/^\s*(?:import|export)\s+type\b/.test(m[0].replace(/^\s*\n/, ''))) continue
    const spec = m[1] || m[2]
    const r = resolveLocal(f, spec)
    if (r) imports.push(r)
    else if (!spec.startsWith('.') && !spec.startsWith('@/')) externals.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
  }
  let unbounded = 0
  const fromRe = /\.from\(\s*['"`]([a-z_0-9]+)['"`]\s*\)/g
  while ((m = fromRe.exec(s))) {
    const chain = s.slice(m.index, m.index + 700).split(/;|\n\s*\n/)[0]
    if (/\.select\(/.test(chain) && !/\.(limit|range|single|maybeSingle)\(|head:\s*true|count:\s*['"]exact/.test(chain)) unbounded++
  }
  const firstCode = s.split('\n').find((l) => l.trim() && !/^\s*(\/\/|\/\*|\*)/.test(l)) || ''
  info.set(f, {
    bytes: s.length, imports, externals: [...externals], useClient: /^['"]use client['"]/.test(firstCode.trim()),
    db: count(s, /\.from\(\s*['"`]/g), rpc: count(s, /\.rpc\(/g), api: count(s, /fetch\(\s*[`'"]\/api|authedFetch\(|apiFetch\(|fetchWithAuth\(/g),
    query: count(s, /\buse(?:Infinite)?Quer(?:y|ies)\(/g), unbounded,
    star: count(s, /\.select\(\s*['"`]\*['"`]/g), all: count(s, /fetchAllRows|supabasePaging|fetchAll\(/g),
    poll: count(s, /setInterval\(|refetchInterval/g), img: count(s, /<img\b/g),
  })
}

const reach = (start) => {
  const seen = new Set(); const q = [start]
  while (q.length) { const f = q.pop(); if (seen.has(f)) continue; seen.add(f); for (const n of info.get(f)?.imports ?? []) q.push(n) }
  return seen
}
const sum = (set, k) => [...set].reduce((a, f) => a + (info.get(f)?.[k] ?? 0), 0)
const layoutChain = (f) => {
  const out = []
  let d = path.dirname(f)
  while (d.startsWith(path.join(SRC, 'app'))) {
    const l = path.join(d, 'layout.tsx')
    if (fileSet.has(l)) out.push(l)
    if (d === path.join(SRC, 'app')) break
    d = path.dirname(d)
  }
  return out
}
const routeOf = (f) => rel(f).replace(/^src\/app/, '').replace(/\/page\.(tsx|ts|jsx|js)$/, '') || '/'

// how a page is served: static file, prepared-and-cached record page, or a server function on every open
const servedAs = (pageFile) => {
  if (!/\[[^\]]+\]/.test(routeOf(pageFile))) return 'static'
  const dirs = []
  for (let d = path.dirname(pageFile); d.startsWith(path.join(SRC, 'app')); d = path.dirname(d)) if (/^\[[^\].]+\]$/.test(path.basename(d))) dirs.push(d)
  const covered = dirs.every((d) => fileSet.has(path.join(d, 'layout.tsx')) && /generateStaticParams/.test(fs.readFileSync(path.join(d, 'layout.tsx'), 'utf8')))
  return covered ? 'prepared' : 'function'
}

const pages = files.filter((f) => /\/page\.(tsx|ts|jsx|js)$/.test(rel(f)) && rel(f).startsWith('src/app/'))
const rows = pages.map((p) => {
  const own = reach(p)
  const lay = new Set(); for (const l of layoutChain(p)) for (const x of reach(l)) lay.add(x)
  const pageOnly = new Set([...own].filter((x) => !lay.has(x)))
  const ext = new Set(); for (const x of own) for (const e of info.get(x).externals) ext.add(e)
  return {
    route: routeOf(p), client: info.get(p).useClient, served: servedAs(p), kb: Math.round(sum(pageOnly, 'bytes') / 1024), files: pageOnly.size,
    db: sum(pageOnly, 'db'), rpc: sum(pageOnly, 'rpc'), api: sum(pageOnly, 'api'), query: sum(pageOnly, 'query'),
    unbounded: sum(pageOnly, 'unbounded'), star: sum(pageOnly, 'star'), all: sum(pageOnly, 'all'), poll: sum(pageOnly, 'poll'), img: sum(pageOnly, 'img'),
    heavy: [...ext].filter((e) => HEAVY.includes(e)),
  }
}).sort((a, b) => a.route.localeCompare(b.route))

const calls = (r) => r.db + r.rpc + r.api
const top = (key, n, filter = () => true) => [...rows].filter(filter).sort((a, b) => key(b) - key(a) || a.route.localeCompare(b.route)).slice(0, n)
const line = (r) => `| \`${r.route}\` | ${r.served} | ${r.client ? 'client' : 'server'} | ${r.kb} KB / ${r.files} | ${calls(r)} (${r.db}/${r.rpc}/${r.api}) | ${r.query || '-'} | ${r.unbounded || '-'} | ${r.all || '-'} | ${r.poll || '-'} | ${r.heavy.join(', ') || '-'} |`
const header = '| Route | Served | Page | Own code (source) | Data calls (db/rpc/api) | Query-cache hooks | Reads with no limit | Fetch-all loops | Polling | Heavy libs |\n|---|---|---|---|---|---|---|---|---|---|'

const L = []
L.push('# Page load audit (generated)', '')
L.push('Generated by `node scripts/audit-page-load.mjs`. **Do not edit.** It reads the source and follows each page\'s imports; it cannot see run time, so a number here is a pointer to look, not a measurement. Measure a page before and after you change it.', '')
L.push('How to read the columns: **Served** is `static` (a file from the edge), `prepared` (a record page prepared on first open, then cached) or `function` (rendered by a server function in Tokyo on every open). **Own code** is the page\'s code that is not already in its shell, as source size and file count (an upper bound for the bundle). **Data calls** counts `.from()`, `.rpc()` and `/api` call sites in that code. **Reads with no limit** are selects with no limit, range or single, which can return up to 1000 rows each. **Fetch-all loops** page through a whole table. **Polling** is a timer or refetch interval.', '')
L.push('## Summary', '')
L.push(`- Pages: ${rows.length}; source files read: ${files.length}.`)
L.push(`- Served: ${rows.filter((r) => r.served === 'static').length} static, ${rows.filter((r) => r.served === 'prepared').length} prepared and cached, ${rows.filter((r) => r.served === 'function').length} by a server function on every open.`)
L.push(`- Client pages: ${rows.filter((r) => r.client).length}; pages that read data without the shared query cache: ${rows.filter((r) => calls(r) > 0 && r.query === 0).length} of ${rows.filter((r) => calls(r) > 0).length}.`)
L.push(`- Reads with no limit: ${rows.reduce((s, r) => s + r.unbounded, 0)} in ${rows.filter((r) => r.unbounded).length} pages; fetch-all loops in ${rows.filter((r) => r.all).length} pages; select("*") in ${rows.filter((r) => r.star).length}; polling in ${rows.filter((r) => r.poll).length}. (Pages import their module shell directly, so "own code" and these counts include the shell: compare pages of one module with each other, not across modules.)`, '')
L.push('## Heaviest pages by data calls', '', header, ...top(calls, 15).map(line), '')
L.push('## Pages that fetch everything (fetch-all loops)', '', header, ...top((r) => r.all, 15, (r) => r.all > 0).map(line), '')
L.push('## Pages still rendered by a server function on every open', '', header, ...rows.filter((r) => r.served === 'function').map(line), '')
L.push('## Every page', '', header, ...rows.map(line), '')
const text = L.join('\n')

if (process.argv.includes('--check')) {
  const have = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : ''
  if (have !== text) { console.error('PAGE_LOAD_AUDIT.generated.md is stale: run node scripts/audit-page-load.mjs'); process.exit(1) }
  console.log('page load audit up to date')
} else {
  fs.writeFileSync(OUT, text)
  console.log(`wrote ${rel(OUT)} (${rows.length} pages)`)
}
