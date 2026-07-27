/**
 * MultilineText — behavioural tests
 *
 * Covers the rendering contract for user-entered task text (descriptions,
 * comments, status notes): line breaks and blank lines survive to the DOM,
 * long unbroken strings wrap instead of overflowing, and plain text that
 * looks like HTML is escaped rather than interpreted.
 *
 * Run:
 *   npx tsx --test src/components/ui/MultilineText.test.tsx
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { MultilineText } from './MultilineText'

/** Rendered markup for `text`, plus the inline style string on the wrapper. */
const render = (text: string, style?: React.CSSProperties) =>
  renderToStaticMarkup(<MultilineText style={style}>{text}</MultilineText>)

/** The text content between the <p> tags, with entities left as-is. */
const inner = (html: string) => html.replace(/^<p[^>]*>/, '').replace(/<\/p>$/, '')

describe('MultilineText', () => {
  test('a description with two lines keeps the newline', () => {
    const html = render('First line\nSecond line with more text')
    assert.equal(inner(html), 'First line\nSecond line with more text')
    assert.match(html, /white-space:pre-wrap/)
  })

  test('a description with a blank line keeps the paragraph gap', () => {
    const source = 'Call the client.\n\nConfirm the fabric selection.'
    assert.equal(inner(render(source)), source)
    // The blank line must survive as a real empty line, not collapse to one \n.
    assert.match(inner(render(source)), /\.\n\nConfirm/)
  })

  test('a comment with several lines renders each line separately', () => {
    const source = 'Call the client.\n\nConfirm the fabric selection.\nShare the final update with production.'
    const out = inner(render(source))
    assert.equal(out, source)
    assert.equal(out.split('\n').length, 4)          // 3 lines + the blank one
    assert.equal(out.split('\n')[1], '')             // the blank line is preserved
  })

  test('long unbroken text is allowed to wrap rather than overflow', () => {
    const html = render('A'.repeat(400))
    assert.match(html, /overflow-wrap:anywhere/)
  })

  test('an existing single-line description is unchanged', () => {
    assert.equal(inner(render('Follow up with the vendor')), 'Follow up with the vendor')
  })

  test('leading and trailing spaces inside a line are preserved', () => {
    // pre-wrap keeps runs of spaces, so alignment a user typed is not collapsed.
    assert.equal(inner(render('Item 1:   two   spaces')), 'Item 1:   two   spaces')
  })

  test('HTML-like plain text is escaped, never interpreted as markup', () => {
    const html = render('<b>bold?</b> <script>alert(1)</script>')
    assert.doesNotMatch(html, /<script>/)
    assert.doesNotMatch(html, /<b>bold/)
    assert.match(html, /&lt;b&gt;bold\?&lt;\/b&gt;/)
    assert.match(html, /&lt;script&gt;/)
  })

  test('caller styles are applied but cannot override the whitespace rules', () => {
    const html = render('one\ntwo', {
      fontSize: '12.5px',
      // A caller passing a conflicting value must not be able to re-flatten text.
      whiteSpace: 'nowrap',
      overflowWrap: 'normal',
    })
    assert.match(html, /font-size:12\.5px/)
    assert.match(html, /white-space:pre-wrap/)
    assert.match(html, /overflow-wrap:anywhere/)
    assert.doesNotMatch(html, /white-space:nowrap/)
  })

  test('an edited comment renders the saved text without flattening it', () => {
    // saveActivityEdit stores editActivityNote.trim() — trim strips only the
    // outer whitespace, so the interior structure must still come back intact.
    const edited = '  Updated after the call.\n\nWaiting on the architect.  '.trim()
    assert.equal(inner(render(edited)), 'Updated after the call.\n\nWaiting on the architect.')
  })

  test('a label span followed by note text keeps the note structure', () => {
    // Mirrors the "Blocker: " / "Reason: " rows on the task detail page.
    const html = renderToStaticMarkup(
      <MultilineText style={{ fontSize: '11.5px' }}>
        <span style={{ fontWeight: 700 }}>Reason: </span>
        {'Client unreachable.\n\nRetrying tomorrow.'}
      </MultilineText>,
    )
    assert.match(html, /Reason: <\/span>Client unreachable\.\n\nRetrying tomorrow\./)
  })
})
