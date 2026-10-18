import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expandSplits, readRawSource } from './readScreenSource'

// Guards the screen-split mechanism (docs/testing/writing-tests.md, "Splitting a screen").

const MARKER = '// @split: '

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sourceFiles(p, out)
    else if (/[.]tsx?$/.test(name) && !/[.]test[.]tsx?$/.test(name)) out.push(p)
  }
  return out
}

const markers: Array<{ file: string; sibling: string }> = []
for (const file of sourceFiles(join(process.cwd(), 'src'))) {
  for (const line of readRawSource(file).split(String.fromCharCode(10))) {
    const t = line.trim()
    if (t.startsWith(MARKER)) markers.push({ file, sibling: t.slice(MARKER.length).split(' ')[0] })
  }
}

describe('screen split markers', () => {
  test('there are splits to guard', () => {
    assert.ok(markers.length > 0)
  })

  test('every marker points at an existing file', () => {
    for (const m of markers) {
      assert.ok(existsSync(resolve(process.cwd(), m.sibling)), `${m.file}: ${m.sibling} does not exist`)
    }
  })

  test('expanding a screen leaves no marker behind', () => {
    for (const m of markers) {
      const expanded = expandSplits(readRawSource(m.file))
      assert.ok(!expanded.split(String.fromCharCode(10)).some(l => l.trim().startsWith(MARKER)), `${m.file} still has a marker after expansion`)
    }
  })

  test('a plain readFileSync from a test sees the whole screen (the preload is active)', () => {
    // If this fails you ran the test with bare `tsx --test`. Use `npm test` or `npm run test:file -- <path>`.
    const view = readFileSync(join(process.cwd(), 'src/app/finance/received/ReceivedPaymentsView.tsx'), 'utf8')
    assert.ok(!view.includes(MARKER), 'markers are unexpanded: run via npm test / npm run test:file')
    assert.ok(view.includes('function RowActionsMenu'), 'the split-out RowActionsMenu is back in place')
  })
})
