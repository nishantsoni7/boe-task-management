/**
 * WHERE TWO SECTIONS SIT ON THE TWO PI SCREENS — read from the JSX TREE.
 *
 * The money already received against a PI, and the verdict on whether a PI can
 * be saved, both belong above the product table rather than below it. Guarding
 * that with `source.indexOf(a) < source.indexOf(b)` is not enough: string
 * position is not render position, so an indexOf guard passes just as happily
 * when a section is moved INSIDE the card it is supposed to precede.
 *
 * So each page is parsed and the tree is asked the structural question instead:
 * among the direct children of one parent, in render order, which comes first?
 * A section nested into another element stops being a sibling and fails here.
 *
 * The one thing a tree cannot see is CSS `order`, which reorders flex children
 * without touching the markup — and this page uses it deliberately, inside the
 * lower grid. The last test proves it is not in play on the page stack itself,
 * so DOM order really is screen order.
 *
 * Offline and pure: reads three files, parses them.
 *
 * Run:
 *   npx tsx --test src/app/orders/piSectionOrder.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const tagName = (n: ts.Node): string | null =>
  ts.isJsxElement(n) ? n.openingElement.tagName.getText()
  : ts.isJsxSelfClosingElement(n) ? n.tagName.getText()
  : null

/**
 * The direct children of a JSX element, in render order, each reduced to every
 * tag and identifier beneath it.
 *
 * That set is how a child is IDENTIFIED: `<Card>` alone does not say which card
 * it is, but the one reaching for READY_TITLE or rendering PiProductTableHead
 * says so unambiguously, however its insides are later rearranged. A child
 * wrapped in `{cond && …}` is still one child in one slot, which is how React
 * renders it, so the expression is unwrapped rather than skipped.
 */
function sections(parent: ts.JsxElement): Set<string>[] {
  return parent.children.flatMap(child => {
    const node = ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) ? child
      : ts.isJsxExpression(child) ? child.expression
      : undefined
    if (!node) return []
    const marks = new Set<string>()
    const walk = (n: ts.Node) => {
      const tag = tagName(n)
      if (tag) marks.add(tag)
      if (ts.isIdentifier(n)) marks.add(n.text)
      n.forEachChild(walk)
    }
    walk(node)
    return marks.size > 0 ? [marks] : []
  })
}

/** The page stack of the draft detail page, and the preview block of New Order. */
function stackOf(path: string, locate: (root: ts.SourceFile) => ts.JsxElement | null): Set<string>[] {
  const root = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found = locate(root)
  assert.ok(found, `${path}: could not locate the section stack`)
  const list = sections(found)
  assert.ok(list.length >= 4, `${path}: expected the page's sections, got ${list.length}`)
  return list
}

function search<T extends ts.Node>(root: ts.Node, match: (n: ts.Node) => n is T): T | null {
  let hit: T | null = null
  const walk = (n: ts.Node) => {
    if (hit) return
    if (match(n)) { hit = n; return }
    n.forEachChild(walk)
  }
  walk(root)
  return hit
}

const byClassName = (name: string) => (root: ts.SourceFile) =>
  search(root, (n): n is ts.JsxElement =>
    ts.isJsxElement(n) && n.openingElement.attributes.properties.some(a =>
      ts.isJsxAttribute(a) && a.name.getText() === 'className'
      && !!a.initializer && ts.isStringLiteral(a.initializer) && a.initializer.text === name))

const byAssignment = (name: string) => (root: ts.SourceFile) => {
  const decl = search(root, (n): n is ts.VariableDeclaration =>
    ts.isVariableDeclaration(n) && n.name.getText() === name)
  return decl?.initializer ? search(decl.initializer, ts.isJsxElement) : null
}

/** Where the one section carrying `marker` sits — and proof there is only one. */
function at(list: Set<string>[], marker: string): number {
  const hits = list.flatMap((marks, i) => marks.has(marker) ? [i] : [])
  assert.equal(hits.length, 1,
    `expected exactly one rendered section referencing ${marker}, found ${hits.length}`)
  return hits[0]
}

describe('the two PI screens put the answer above the product table', () => {
  test('PI draft detail: the summary is above the actions and the products', () => {
    const s = stackOf('src/app/orders/drafts/[submissionId]/page.tsx',
      byClassName('pi-detail-stack'))
    // Siblings in the page stack: nested into any card, these would not be found.
    // The identity strip is gone: status, creator, timestamp and workbook all
    // live inside the summary card now, so the page opens with the card itself.
    // The page builds the workflow panel once (`workflowPanel`) and places it in
    // the section that also holds the Complete PI details area.
    // The panel is drawn in the commercial row when the completion area shows, and
    // in the decision row when it does not — so the EARLIEST section is the one the
    // reader meets first.
    const firstPanel = s.findIndex(marks => marks.has('workflowPanel'))
    assert.ok(at(s, 'PiTopCard') < firstPanel,
      'who, when and how much paid — above the controls that act on them')
    assert.ok(at(s, 'PiCommercialCard') === firstPanel && firstPanel < at(s, 'PiCompletionPanel'),
      'Management review sits directly under Product value and Total before GST, above the Complete PI details area')
    assert.ok(at(s, 'PiCompletionPanel') < at(s, 'PiProductTableHead'),
      'the details a PI needs are completed above the products, not below them')
    assert.ok(at(s, 'PiTopCard') < at(s, 'PiProductTableHead'),
      'the money received must not sit below the lines it was received against')
    assert.ok(at(s, 'PiProductTableHead') < at(s, 'PiLowerGrid'),
      'the commercial breakdown and Activity stay below the products')
  })

  // ── Upload PI: the verdict and the action come FIRST (2026-09-27) ──
  //
  // Directly under the Upload PI heading: what blocks the PI — or, when
  // nothing does, the Save Draft card (the two are never drawn together) —
  // then what is worth checking, and only then Order information, the lines
  // and what they come to. Below a twenty-line product table Sales scrolled
  // every row to learn whether the PI could be saved and to reach the button
  // that saves it. (This supersedes the earlier "the action comes last" order.)
  test('Upload PI: errors or Save Draft first, warnings next, then the document', () => {
    const s = stackOf('src/app/orders/import/page.tsx', byAssignment('previewBlock'))
    assert.equal(at(s, 'BLOCKING_PANEL_TITLE'), 0, 'a blocked PI says so first of all')
    assert.equal(at(s, 'READY_TITLE'), 1, 'the Save Draft card is next — the first card on a clean PI')
    assert.equal(at(s, 'SAVE_BUTTON_LABEL'), at(s, 'READY_TITLE'),
      'and the one control of this screen belongs to that same card')
    assert.equal(at(s, 'WARNING_PANEL_TITLE'), 2, 'then what is worth checking')
    assert.ok(at(s, 'WARNING_PANEL_TITLE') < at(s, 'buildOrderInformationRows'))
    assert.ok(at(s, 'buildOrderInformationRows') < at(s, 'PiProductTableHead'))
    assert.ok(at(s, 'PiProductTableHead') < at(s, 'PiCommercialSummary'))
  })

  test('Upload PI: the blocking panel is rendered once, and only when it has entries', () => {
    const source = read('src/app/orders/import/page.tsx')
    assert.equal((source.match(/BLOCKING_PANEL_TITLE/g) ?? []).length, 2,
      'the import and the one rendering — a second copy is how the two drift')
    const panelAt = source.indexOf('{BLOCKING_PANEL_TITLE}')
    const guardAt = source.lastIndexOf('preview.groups.blocking.length > 0 && (', panelAt)
    assert.ok(guardAt > -1 && guardAt < panelAt,
      'a clean PI renders no empty "Must be fixed before submission" card')
  })

  test('no CSS `order` reaches the page stack, so DOM order is screen order', () => {
    const css = read('src/app/globals.css')
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(^|[^-\w])order\s*:/.test(body)) continue
      assert.ok(!/\.pi-detail-stack/.test(selector),
        `${selector.trim()} reorders the page stack — DOM order would stop being visual order`)
    }
    const rule = css.slice(css.indexOf('.pi-detail-stack {')).split('}')[0]
    assert.match(rule, /flex-direction:\s*column/)
    assert.ok(!/(^|[^-\w])order\s*:|column-reverse|flex-wrap/.test(rule),
      'and the stack itself neither reorders nor wraps its sections')
  })
})
