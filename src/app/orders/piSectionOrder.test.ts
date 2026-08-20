/**
 * WHERE THE SECTIONS SIT ON THE TWO PI SCREENS — read from the JSX TREE.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The order of the cards on these two screens is a product decision, not a
 * detail: the verdict on a PI, and the money already received against it, are
 * what a person opens the screen for, and both used to sit BELOW a product
 * table they had to scroll past.
 *
 * The obvious way to guard that is `source.indexOf(a) < source.indexOf(b)`, and
 * it is not good enough. String position is not render position: it says
 * nothing about NESTING, so it passes just as happily when a section is moved
 * INSIDE the card it is supposed to precede, or into a branch that never
 * renders. A guard that can be satisfied by markup nobody sees is a guard that
 * will eventually be satisfied by markup nobody sees.
 *
 * So this file parses each page with the TypeScript compiler and asks the JSX
 * tree the structural question instead: within one parent, in the order the
 * children are actually rendered, which section comes first? A section moved
 * inside another element is no longer a sibling and fails, where indexOf would
 * have passed.
 *
 * WHAT THIS STILL CANNOT SEE, AND WHAT COVERS IT
 * ----------------------------------------------
 * One mechanism can still divorce DOM order from what the eye sees: CSS
 * `order`, which reorders flex and grid children without touching the markup.
 * This page uses it deliberately, twice — inside the overview card and inside
 * the lower grid. So the last test here proves it is not in play at the level
 * that matters: the page stack itself, and its direct children.
 *
 * Beyond that, the real browser is the authority, and a person can run it —
 * scripts/verify-pi-section-order.mjs, whose header carries the exact steps.
 * It drives a real Chromium against a real dev server, stubs Supabase at the
 * network layer, and compares the on-screen Y positions of the Payments card,
 * the ready-to-submit card and the first product row at desktop and phone
 * widths. It is not part of `npm test` because it needs a browser and a running
 * server; the tests below are the ones that run on every change.
 *
 * Offline and pure: reads two files, parses them. No network, no database.
 *
 * Run:
 *   npx tsx --test src/app/orders/piSectionOrder.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const DETAIL_PAGE = 'src/app/orders/drafts/[submissionId]/page.tsx'
const IMPORT_PAGE = 'src/app/orders/import/page.tsx'
const GLOBALS_CSS = 'src/app/globals.css'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

/** The tag name of a JSX element, however it is written. */
function tagName(node: ts.Node): string | null {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText()
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText()
  return null
}

/**
 * One rendered child of a parent, in source order.
 *
 * `names` is every tag name anywhere beneath it and `refs` every identifier,
 * which is how a child is IDENTIFIED here: `<Card>` alone does not say which
 * card it is, but the card that reaches for READY_TITLE or renders
 * PiProductTableHead says so unambiguously — and says it no matter how the
 * markup inside is later rearranged.
 */
type Child = { index: number; tag: string; names: Set<string>; refs: Set<string> }

/**
 * The direct children of a JSX element, in render order.
 *
 * A child wrapped in a conditional — `{cond && <Panel/>}` — is still one child
 * in one position, which is exactly how React renders it, so the expression is
 * unwrapped rather than skipped. Whitespace and comments are not children.
 */
function directChildren(parent: ts.JsxElement): Child[] {
  const out: Child[] = []

  for (const child of parent.children) {
    let node: ts.Node | null = null

    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      node = child
    } else if (ts.isJsxExpression(child) && child.expression) {
      // `{cond && <X/>}`, `{cond ? <X/> : null}`, `{value}` — take the whole
      // expression: whatever it renders occupies this one slot.
      node = child.expression
    }
    if (!node) continue

    const names = new Set<string>()
    const refs = new Set<string>()
    const walk = (n: ts.Node) => {
      const tag = tagName(n)
      if (tag) names.add(tag)
      if (ts.isIdentifier(n)) refs.add(n.text)
      n.forEachChild(walk)
    }
    walk(node)

    const tag = tagName(node) ?? '(expression)'
    if (tag === '(expression)' && names.size === 0) continue  // a bare text/value slot
    out.push({ index: out.length, tag, names, refs })
  }

  return out
}

/** Find the first JSX element carrying `className="<name>"`. */
function findByClassName(source: ts.SourceFile, className: string): ts.JsxElement {
  let found: ts.JsxElement | null = null
  const walk = (n: ts.Node) => {
    if (found) return
    if (ts.isJsxElement(n)) {
      for (const attr of n.openingElement.attributes.properties) {
        if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'className') continue
        const init = attr.initializer
        if (init && ts.isStringLiteral(init) && init.text === className) { found = n; return }
      }
    }
    n.forEachChild(walk)
  }
  walk(source)
  assert.ok(found, `no JSX element with className="${className}"`)
  return found
}

/** Find the JSX element assigned to `const <name> = ...`. */
function findAssignedJsx(source: ts.SourceFile, name: string): ts.JsxElement {
  let found: ts.JsxElement | null = null
  const walk = (n: ts.Node) => {
    if (found) return
    if (ts.isVariableDeclaration(n) && n.name.getText() === name && n.initializer) {
      const inner = (m: ts.Node): void => {
        if (found) return
        if (ts.isJsxElement(m)) { found = m; return }
        m.forEachChild(inner)
      }
      inner(n.initializer)
      if (found) return
    }
    n.forEachChild(walk)
  }
  walk(source)
  assert.ok(found, `no JSX assigned to \`${name}\``)
  return found
}

/** The position of the one child identified by a marker, and a readable failure. */
function positionOf(children: Child[], marker: string, label: string): number {
  const hits = children.filter(c => c.names.has(marker) || c.refs.has(marker))
  assert.equal(hits.length, 1,
    `${label}: expected exactly one rendered section referencing ${marker}, found ${hits.length}`
    + ` — a duplicated section is as wrong as a misplaced one`)
  return hits[0].index
}

// ── The PI draft detail page ──────────────────────────────────────────────────

describe('the PI draft detail page renders Payments above the products', () => {
  const stack = directChildren(findByClassName(parse(DETAIL_PAGE), 'pi-detail-stack'))

  const payments = () => positionOf(stack, 'PiPaymentCard', 'detail')
  const products = () => positionOf(stack, 'PiProductTableHead', 'detail')

  test('the stack was parsed, not merely searched', () => {
    assert.ok(stack.length >= 6, `expected the page stack's sections, got ${stack.length}`)
  })

  test('Payments and the product table are SIBLINGS in the page stack', () => {
    // The point of parsing rather than string-matching: if either is moved
    // inside the other, or inside any other card, it stops being a direct child
    // of the stack and positionOf cannot find it here at all.
    assert.ok(payments() >= 0)
    assert.ok(products() >= 0)
  })

  test('Payments comes before the product table', () => {
    assert.ok(payments() < products(),
      'the money already received must not sit below the lines it was received against')
  })

  test('Payments comes after the page header and the primary actions', () => {
    assert.ok(payments() > positionOf(stack, 'PiWorkflowPanel', 'detail'),
      'the workflow panel carries this page’s primary actions and stays above Payments')
    assert.ok(payments() > positionOf(stack, 'PiIdentityStrip', 'detail'))
    assert.ok(payments() > positionOf(stack, 'PiOrderOverview', 'detail'))
  })

  test('the commercial breakdown and Activity stay below the products', () => {
    assert.ok(positionOf(stack, 'PiLowerGrid', 'detail') > products(),
      'reference material a reader drops to AFTER the decisions')
  })

  test('the blocking panel stays above the products, where the products are', () => {
    assert.ok(positionOf(stack, 'PiBlockingPanel', 'detail') < products())
  })

  test('every section is rendered exactly once', () => {
    for (const marker of [
      'PiIdentityStrip', 'PiOrderOverview', 'PiWorkflowPanel', 'PiPaymentCard',
      'PiBlockingPanel', 'PiProductTableHead', 'PiLowerGrid', 'PiWarningPanel',
    ]) {
      positionOf(stack, marker, 'detail')  // throws unless there is exactly one
    }
  })
})

// ── The New Order upload preview ──────────────────────────────────────────────

describe('the New Order preview renders the ready card above the products', () => {
  const preview = directChildren(findAssignedJsx(parse(IMPORT_PAGE), 'previewBlock'))

  const ready = () => positionOf(preview, 'READY_TITLE', 'import')
  const products = () => positionOf(preview, 'PiProductTableHead', 'import')

  test('the preview block was parsed, not merely searched', () => {
    assert.ok(preview.length >= 4, `expected the preview's cards, got ${preview.length}`)
  })

  test('the ready-to-submit card comes before the product table', () => {
    assert.ok(ready() < products(),
      'the verdict on the PI must come before the lines it is a verdict on')
  })

  test('the Save Draft button is inside that card, not stranded below', () => {
    const card = preview[ready()]
    assert.ok(card.refs.has('SAVE_BUTTON_LABEL'),
      'the one action of this screen belongs to the card that says the PI is ready')
    assert.ok(card.refs.has('canSaveDraft'), 'and keeps its shared gate')
  })

  test('the ready card sits directly under the order information', () => {
    const orderInfo = preview.findIndex(c => c.refs.has('buildHeaderRows'))
    assert.notEqual(orderInfo, -1, 'the order-information card must still be there')
    assert.equal(ready(), orderInfo + 1,
      'immediately after the upload summary, with nothing wedged between them')
  })

  test('the commercial summary stays below the products', () => {
    assert.ok(positionOf(preview, 'PiCommercialSummary', 'import') > products())
  })

  test('the ready card is rendered exactly once', () => {
    positionOf(preview, 'READY_TITLE', 'import')
    positionOf(preview, 'PiProductTableHead', 'import')
  })
})

// ── The one thing a JSX tree cannot answer ───────────────────────────────────

describe('nothing reorders the page stack behind the markup', () => {
  const css = read(GLOBALS_CSS)

  test('no CSS `order` applies to the detail page stack or its children', () => {
    // The page DOES use `order` twice, deliberately: inside the overview card
    // (.pi-detail-snapshot) and inside the lower grid (.pi-detail-commercial-col).
    // Both reorder children of a card, never sections of the page. If a rule
    // ever targets the stack itself, DOM order stops being visual order and
    // every assertion above becomes decorative.
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    for (const [, selector, body] of rules) {
      if (!/(^|[^-\w])order\s*:/.test(body)) continue
      assert.ok(!/\.pi-detail-stack/.test(selector),
        `${selector.trim()} reorders the page stack — DOM order would stop being visual order`)
    }
  })

  test('the stack is a plain column, so source order IS screen order', () => {
    const block = css.slice(css.indexOf('.pi-detail-stack {'))
    const rule = block.slice(0, block.indexOf('}'))
    assert.match(rule, /flex-direction:\s*column/)
    assert.ok(!/(^|[^-\w])order\s*:/.test(rule), 'and it sets no order of its own')
    assert.ok(!/flex-wrap|row-reverse|column-reverse/.test(rule),
      'nothing that could reverse or wrap the sections')
  })
})
