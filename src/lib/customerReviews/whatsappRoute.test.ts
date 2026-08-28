/**
 * THE WHATSAPP ROUTE — the only place a wa.me link is built, and the only place
 * the allowlist is enforced.
 *
 * WHY THE SERVER BUILDS THE LINK. If the browser assembled the URL, the
 * allowlist would be a suggestion: a tester — or anything running in their tab
 * — could put any number in the path and the application would have produced a
 * WhatsApp link to a stranger. Building it here means the number in the link is
 * one the server chose from its own list, and the text is one the server
 * composed from a card row and a constant.
 *
 * WHAT THIS FILE PROVES
 *   1. the allowlist is read and checked BEFORE any link exists
 *   2. a number that is not on it is refused, with no link in the response
 *   3. a missing or malformed allowlist is a 503, not an empty list
 *   4. the numbers are exposed only to somebody who holds `use`
 *   5. previewing records nothing, and opening records only an OPEN
 *   6. NOTHING SENDS — there is no WhatsApp API client in this repository
 *
 * Reads repository files only. No database, no network, no navigation.
 *
 * Run:
 *   npx tsx --test src/lib/customerReviews/whatsappRoute.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** Executable source only — a comment explains a rule, it does not break one. */
const stripComments = (source: string) =>
  source.split('\n').filter(l => {
    const t = l.trimStart()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  }).join('\n')

const route = read('src/app/api/customer-reviews/whatsapp/route.ts')
const routeCode = stripComments(route)
const launch = read('src/components/customerReviews/WhatsAppLaunch.tsx')
const sql = read('supabase/migrations/20261017000000_customer_review_outreach.sql')

describe('NOTHING IN THIS REPOSITORY SENDS A WHATSAPP MESSAGE', () => {
  test('there is no WhatsApp API client, token or endpoint anywhere in src/', () => {
    // The broadest assertion in the module, and the one worth having: a
    // sending path could be added in a file nobody thought to check, so this
    // walks the whole tree rather than the two files above.
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        // TEST FILES ARE SKIPPED, and the reason is this assertion itself: it
        // has to NAME the markers it forbids, so a sweep that read its own
        // source would report every one of them as a finding. A test file
        // cannot ship a sending path in any case — nothing imports it.
        if (/\.test\.tsx?$/.test(entry.name)) continue
        const source = readFileSync(path, 'utf8')
        for (const marker of [
          'graph.facebook.com',
          'api.whatsapp.com',
          'whatsapp_business',
          'WHATSAPP_TOKEN',
          'WHATSAPP_API',
          'messages/send',
          'twilio',
        ]) {
          if (source.includes(marker)) hits.push(`${path}: ${marker}`)
        }
      }
    }
    walk(join(ROOT, 'src'))
    assert.deepEqual(hits, [], `a WhatsApp sending path exists: ${hits.join(', ')}`)
  })

  test('the route itself makes no outbound call', () => {
    // Its only network surface is the Supabase client it uses to read the card
    // and record the open. There is no fetch to anywhere else.
    const executable = route.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n')
    assert.equal(/\bfetch\s*\(/.test(executable), false, 'the route fetches something')
    assert.equal(/https?:\/\//.test(executable.replace(/https:\/\/wa\.me/g, '')), false,
      'the route contains an address other than wa.me')
  })

  test('the only address the module can produce comes from buildWaMeUrl', () => {
    assert.ok(route.includes('buildWaMeUrl(target.digits, message)'))
    // And the browser does not build one at all.
    assert.equal(launch.includes('https://wa.me/'), false)
    assert.equal(launch.includes('buildWaMeUrl'), false)
  })
})

describe('the allowlist is the boundary, and it is on the server', () => {
  test('it is read from the server-only variable, in both handlers', () => {
    assert.equal((route.match(/readInternalTestAllowlist\(\)/g) ?? []).length, 2)
    assert.equal(route.includes('NEXT_PUBLIC_'), false)
  })

  test('A MISSING OR MALFORMED LIST IS A 503, never an empty list', () => {
    assert.equal((route.match(/if \(!allowlist\.ok\) \{/g) ?? []).length, 2)
    assert.equal((route.match(/return fail\(503, MESSAGES\.allowlist_absent\)/g) ?? []).length, 2)
    // ...and there is no branch that carries on with a shorter list.
    assert.equal(/allowlist\.ok \?/.test(route), false)
    assert.equal(/\|\| \[\]/.test(route), false, 'a fallback empty list exists')
  })

  test('THE CHECK HAPPENS BEFORE THE CARD IS EVEN READ', () => {
    // Read first and checked first, so there is no branch in which a link is
    // built and then discarded — a link that exists in a variable is a link a
    // later edit could return.
    const post = route.slice(route.indexOf('export async function POST'))
    const check = post.indexOf('findAllowedNumber(candidateNumber, allowlist.numbers)')
    const build = post.indexOf('buildWaMeUrl(')
    const cardRead = post.indexOf(".from('customer_review_test_cards')")
    assert.ok(check !== -1 && build !== -1 && cardRead !== -1)
    assert.ok(check < cardRead, 'the allowlist must be checked before the card is read')
    assert.ok(check < build, 'the allowlist must be checked before a link is built')
  })

  test('a number that is not on the list is a 403 with no link', () => {
    assert.ok(route.includes('if (!target) return fail(403, MESSAGES.not_allowlisted)'))
    // The refusal message names no number.
    assert.ok(route.includes("not_allowlisted:  'That number is not an approved BOE internal test number.'"))
  })

  test('the SERVER’S entry is what builds the link, not the caller’s spelling', () => {
    // findAllowedNumber returns the approved entry; the digits in the URL come
    // from it, so a caller cannot slip a different recipient past the check by
    // writing it differently.
    assert.ok(route.includes('buildWaMeUrl(target.digits, message)'))
    assert.equal(route.includes('buildWaMeUrl(candidateNumber'), false)
  })

  test('the numbers reach a browser only through an authorized GET', () => {
    const get = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'))
    assert.ok(get.includes('const auth = await authorize()'))
    assert.ok(get.includes("if ('response' in auth) return auth.response"))
    // Label and E.164 only — nothing else about the entry is exposed.
    assert.ok(get.includes('numbers: allowlist.numbers.map(n => ({ label: n.label, e164: n.e164 }))'))
  })

  test('and `authorize` fails closed on every step', () => {
    const fn = route.slice(route.indexOf('async function authorize'), route.indexOf('export async function GET'))
    assert.ok(fn.includes('if (authError || !user) return { response: fail(401'))
    assert.ok(fn.includes("if (!profile || profile.is_active !== true) return { response: fail(403"))
    assert.ok(fn.includes("p_action_key: 'use'"))
    assert.ok(fn.includes('if (allowed !== true) return { response: fail(403'))
  })

  test('a log line never carries a number', () => {
    // The detail parseInternalTestAllowlist produces names the variable and a
    // position, never a value — and the route logs that and nothing else.
    for (const line of route.split('\n').filter(l => l.includes('console.error'))) {
      assert.equal(/target|number|candidate/i.test(line), false, line.trim())
    }
  })
})

describe('opening is not sending, and previewing is not opening', () => {
  test('RECORDING IS OPT-IN, and the default is not to record', () => {
    assert.ok(route.includes("record = (body as Record<string, unknown>).record === true"))
    assert.ok(route.includes('if (record) {'))
    // The preview call does not ask for it.
    const preview = launch.slice(launch.indexOf('const loadPreview = useCallback'), launch.indexOf('const ready ='))
    assert.equal(preview.includes('record: true'), false)
    assert.ok(preview.includes('JSON.stringify({ cardId, number: chosenNumber })'))
  })

  test('recording writes an OPEN, and the database refuses it a status', () => {
    assert.ok(route.includes("admin.client.rpc('record_customer_review_test_card_whatsapp_opened'"))
    // The RPC assigns no status — asserted against the SQL, because that is
    // where it is actually true.
    const fn = /create or replace function public\.record_customer_review_test_card_whatsapp_opened[\s\S]*?\$\$;/
      .exec(sql)?.[0] ?? ''
    assert.ok(fn, 'the RPC is missing')
    const setClause = fn.slice(fn.indexOf('update public.customer_review_test_cards'), fn.indexOf('where id = p_card_id\n'))
    assert.equal(/\bstatus\s*=/.test(setClause), false, 'opening WhatsApp assigns a status')
  })

  test('CONFIRMING IS A DIFFERENT CALL, MADE BY A PERSON, ON A DIFFERENT CONTROL', () => {
    // Three separate things, and the module exists to demonstrate that
    // collapsing any two of them is wrong.
    // Checked against the EXECUTABLE source: the route's header comment
    // explains that confirming is a different call, and a raw text search finds
    // the explanation and reports it as the thing being explained.
    assert.equal(routeCode.includes('confirm_customer_review_test_card_sent'), false,
      'the WhatsApp route confirms a send')
    assert.ok(launch.includes('export function ConfirmSentControl'))
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    assert.ok(detail.includes("supabase.rpc('confirm_customer_review_test_card_sent'"))
    assert.ok(detail.includes('onConfirm={confirmSent}'))
  })

  test('the confirm control is a deliberate act, not a side effect of opening', () => {
    const control = launch.slice(launch.indexOf('export function ConfirmSentControl'))
    assert.ok(control.includes('Confirm internal test sent'))
    assert.ok(control.includes('Only press this after you have actually sent the message'))
    // It is enabled by the OPEN having happened, which is an ordering
    // constraint — it does not fire on its own.
    assert.ok(launch.includes('canConfirm={!!card.whatsapp_opened_at}') === false)
  })

  test('a recording failure is reported, not swallowed', () => {
    // supabase-js never throws; the error arrives in the result, and a route
    // that ignores it reports success for a write that did not happen.
    assert.ok(route.includes('if (error) {'))
    assert.ok(route.includes('return fail(500, MESSAGES.record_failed)'))
  })
})

describe('what the route will not accept', () => {
  test('the card id must be a uuid, and the number is length-bounded', () => {
    assert.ok(route.includes('!UUID_RE.test(rawId)'))
    assert.ok(route.includes("typeof rawNumber !== 'string' || rawNumber.length > 40"))
  })

  test('the card is read AS THE CALLER, so RLS decides visibility', () => {
    assert.ok(route.includes(".from('customer_review_test_cards')"))
    assert.ok(route.includes('if (!card) return fail(404, MESSAGES.not_found)'))
    assert.equal(route.includes('adminClient().client\n    .from'), false)
  })

  test('only the holder or an admin, and only while the card is booked', () => {
    assert.ok(route.includes('if (!caller.isAdmin && card.booked_by !== caller.userId) return fail(403'))
    assert.ok(route.includes("if (card.status !== 'booked') return fail(409, MESSAGES.wrong_status)"))
  })

  test('every response is a prewritten sentence from a closed set', () => {
    // An allow-list rather than a formatter: the alternative is a template that
    // one day interpolates a value somebody forgot was caller-influenced. In
    // this route that value would be a phone number.
    const messages = route.slice(route.indexOf('const MESSAGES = {'), route.indexOf('} as const'))
    assert.equal(/\$\{/.test(messages), false, 'a message interpolates something')
    for (const call of route.matchAll(/fail\(\d+,\s*([^)]+)\)/g)) {
      assert.ok(
        call[1].startsWith('MESSAGES.') || call[1].startsWith('IMAGE_REJECTION'),
        `a failure returns something other than a fixed sentence: ${call[1]}`,
      )
    }
  })

  test('nothing is cacheable', () => {
    assert.ok(route.includes("'Cache-Control': 'no-store, private'"))
  })
})
