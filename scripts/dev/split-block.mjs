// Developer tool: move a block of a big screen into its own file, leave a marker, wire imports.
//   node scripts/dev/split-block.mjs <mainFile> "<start text>" "<end text|EOF>" <newFile> [reexportName...]
// The block is [start, end). Top-level declarations in it are exported from the new file and imported
// back. Imports for the new file are collected from the main file's imports and from sibling modules that
// the main file already imports from (./x). Run eslint afterwards and prune unused imports.
// See docs/testing/writing-tests.md ("Splitting a screen").
import fs from 'node:fs'
import path from 'node:path'
const [, , mainFile, startText, endText, newFile, ...reexports] = process.argv
const NL = '\n'
const rd = f => fs.readFileSync(f, 'utf8').split('\r\n').join(NL)
const wr = (f, s, crlf) => fs.writeFileSync(f, crlf ? s.split(NL).join('\r\n') : s)
const crlf = fs.readFileSync(mainFile, 'utf8').includes('\r\n')
let main = rd(mainFile)
const a = main.indexOf(startText)
if (a < 0) throw new Error('start not found')
const b = endText === 'EOF' ? main.length : main.indexOf(endText, a + 1)
if (b < 0) throw new Error('end not found')
let block = main.slice(a, b)

const declRe = /^(export )?(async function|function|const|type|interface|class) ([A-Za-z_$][A-Za-z0-9_$]*)/gm
const names = [], types = [], priv = []
block = block.replace(declRe, (m, e, kind, name) => {
  ;(kind === 'type' || kind === 'interface' ? types : names).push(name)
  if (!e) priv.push(name)
  return e ? m : 'export ' + m
})
const wordIn = (text, id) => new RegExp('(^|[^A-Za-z0-9_$])' + id.replace(/\$/g, '[$]') + '($|[^A-Za-z0-9_$])').test(text)

// imports of the main file
const importRe = /^import (type )?([^;]*?) from '([^']+)'\n/gm
const imports = [...main.matchAll(importRe)]
const out = []
for (const m of imports) {
  const typeOnly = !!m[1]; const spec = m[2]; const mod = m[3]
  if (mod === './' + path.basename(newFile, path.extname(newFile))) continue
  const lb = spec.indexOf('{'), rb = spec.lastIndexOf('}')
  const def = (lb >= 0 ? spec.slice(0, lb) : spec).replace(/,/g, '').trim()
  const list = lb >= 0 ? spec.slice(lb + 1, rb).split(',').map(x => x.trim()).filter(Boolean) : []
  const idOf = x => x.replace(/^type /, '').split(' as ').pop().trim()
  if (def.startsWith('* as')) { if (wordIn(block, def.split(' as ')[1].trim())) out.push('import ' + (typeOnly ? 'type ' : '') + def + " from '" + mod + "'"); continue }
  const keepDef = def && wordIn(block, def) ? def : ''
  const keep = list.filter(x => wordIn(block, idOf(x)))
  if (!keepDef && !keep.length) continue
  out.push('import ' + (typeOnly ? 'type ' : '') + [keepDef, keep.length ? '{ ' + keep.join(', ') + ' }' : ''].filter(Boolean).join(', ') + " from '" + mod + "'")
}
// names exported by sibling modules the main file already imports from (./x) -- already covered by imports above.

const rel = './' + path.basename(newFile, path.extname(newFile))
const header = "'use client'\n\n// Split out of " + path.basename(mainFile) + " (it had grown past 3,000 lines). Nothing here changed.\n\n"
wr(newFile, header + out.join(NL) + NL + NL + block.replace(/\n+$/, NL), crlf)

const impNames = [...names, ...types.map(t => 'type ' + t)]
const reexp = reexports.length ? NL + 'export { ' + reexports.join(', ') + " } from '" + rel + "'" : ''
const repl = 'import { ' + impNames.join(', ') + " } from '" + rel + "'" + reexp + NL +
  '// @split: ' + newFile.split(String.fromCharCode(92)).join('/') + (priv.length ? ' private=' + priv.join(',') : '') + NL + NL
main = main.slice(0, a) + repl + main.slice(b)
// put the import statement with the other imports is not required; it stays at the cut position (valid TS).
wr(mainFile, main, crlf)
console.log('moved', names.length, 'values and', types.length, 'types to', newFile)
