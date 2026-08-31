/**
 * THE WHATSAPP ROUTE — the only place a wa.me link is built.
 *
 * ANY VALID NUMBER, AND WHAT STANDS IN PLACE OF THE ALLOWLIST. A tester enters
 * whatever international number they want to test against. That widened who can
 * be reached; it widened nothing about who can reach them, and this file is the
 * list of what still has to be true:
 *
 *   1. only an active `use` holder, and only for a card THEY hold
 *   2. the number is validated ON THE SERVER, whatever the browser did
 *   3. the confirmation is required by the REQUEST, not by the form
 *   4. the message is composed here and carries the mandatory label
 *   5. previewing records nothing; opening records only an OPEN
 *   6. nothing full is stored, logged or returned — four digits and a
 *      fingerprint
 *   7. NOTHING SENDS — there is no WhatsApp API client in this repository
 *   8. NO ENVIRONMENT VARIABLE is needed to reach a number
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
const launchCode = stripComments(launch)
const sql = read('supabase/migrations/20261017000000_customer_review_outreach.sql')

describe('NOTHING IN THIS REPOSITORY SENDS A WHATSAPP MESSAGE', () => {
  test('there is no WhatsApp API client, token or endpoint anywhere in src/', () => {
    // The broadest assertion in the module, and the one worth having: a sending
    // path could be added in a file nobody thought to check, so this walks the
    // whole tree rather than the two files above.
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
    assert.equal(/\bfetch\s*\(/.test(routeCode), false, 'the route fetches something')
    assert.equal(/https?:\/\//.test(routeCode), false,
      'the route contains an absolute address')
  })

  test('the only address the module can produce comes from buildWaMeUrl', () => {
    assert.ok(route.includes('buildWaMeUrl(normalized.digits, message)'))
    // And the browser does not build one at all.
    assert.equal(launchCode.includes('wa.me/'), false)
    assert.equal(launchCode.includes('buildWaMeUrl'), false)
  })
})

describe('THERE IS NO ALLOWLIST, AND NONE IS REQUIRED', () => {
  test('the module no longer ships one', () => {
    for (const gone of [
      'src/lib/customerReviews/allowlist.ts',
      'src/lib/customerReviews/allowlist.test.ts',
    ]) {
      assert.throws(() => read(gone), `${gone} still exists`)
    }
  })

  test('NO ENVIRONMENT VARIABLE GATES A RECIPIENT', () => {
    // The route reads process.env for exactly nothing. The one credential the
    // recording path needs is the deployment's existing service-role key, read
    // by adminClient() and by recipientPrivacy — neither of which decides WHO
    // may be messaged.
    assert.equal(routeCode.includes('process.env'), false, 'the route reads an environment variable')
    assert.equal(route.includes('BOE_INTERNAL_TEST_WHATSAPP_NUMBERS'), false)
    assert.equal(read('.env.example').includes('BOE_INTERNAL_TEST_WHATSAPP_NUMBERS'), false)
  })

  test('and no approved-list code survives anywhere in the module', () => {
    for (const file of [
      'src/app/api/customer-reviews/whatsapp/route.ts',
      'src/components/customerReviews/WhatsAppLaunch.tsx',
      'src/app/customer-reviews/[id]/TestCardDetailScreen.tsx',
      'src/lib/customerReviews/contact.ts',
    ]) {
      const executable = stripComments(read(file))
      assert.equal(/allowlist|approvedNumbers|findAllowedNumber/i.test(executable), false,
        `${file} still has allowlist code`)
    }
  })
})

describe('the number is validated on the server', () => {
  test('THE SERVER RE-VALIDATES, whatever the browser did', () => {
    assert.ok(route.includes("import { normalizeWhatsAppNumber } from '@/lib/customerReviews/contact'"))
    assert.ok(route.includes('const normalized = normalizeWhatsAppNumber(typedNumber)'))
    assert.ok(route.includes('if (!normalized.ok) return fail(400, normalized.error)'))
  })

  test('IT IS VALIDATED BEFORE THE CARD IS READ AND BEFORE A LINK EXISTS', () => {
    // There is no branch in which a link is built and then discarded — a link
    // that exists in a variable is a link a later edit could return.
    const post = route.slice(route.indexOf('export async function POST'))
    const validate = post.indexOf('const normalized = normalizeWhatsAppNumber(typedNumber)')
    const cardRead = post.indexOf(".from('customer_review_test_cards')")
    const build = post.indexOf('buildWaMeUrl(')
    assert.ok(validate !== -1 && cardRead !== -1 && build !== -1)
    assert.ok(validate < cardRead, 'the number must be validated before the card is read')
    assert.ok(validate < build, 'the number must be validated before a link is built')
  })

  test('the raw input is length-bounded before anything else touches it', () => {
    assert.ok(route.includes('const MAX_INPUT_LENGTH = 40'))
    assert.ok(route.includes("typeof rawNumber !== 'string' || rawNumber.length > MAX_INPUT_LENGTH"))
  })

  test('the wa.me path is built from DIGITS ONLY, from the normalised form', () => {
    assert.ok(route.includes('buildWaMeUrl(normalized.digits, message)'))
    assert.equal(route.includes('buildWaMeUrl(typedNumber'), false)
  })

  test('the card id must be a uuid before it reaches a query', () => {
    assert.ok(route.includes('!UUID_RE.test(rawId)'))
  })
})

describe('THE CONFIRMATION IS REQUIRED BY THE REQUEST', () => {
  test('it is checked on the server, before the number is even parsed', () => {
    const post = route.slice(route.indexOf('export async function POST'))
    const check = post.indexOf('if (!confirmed) return fail(400, MESSAGES.not_confirmed)')
    const validate = post.indexOf('const normalized = normalizeWhatsAppNumber(typedNumber)')
    assert.ok(check !== -1, 'the confirmation is not checked')
    assert.ok(check < validate, 'the confirmation must be checked before the number is parsed')
  })

  test('STRICTLY TRUE — a truthy value is not a confirmation', () => {
    // `confirmed: 'yes'` or `1` would let a client tick the box by accident,
    // which is the opposite of what a deliberate confirmation is for.
    assert.ok(route.includes("confirmed = fields.confirmed === true"))
    assert.equal(/confirmed\s*=\s*!!/.test(route), false)
    assert.equal(/Boolean\(fields\.confirmed\)/.test(route), false)
  })

  test('and the browser cannot produce a link without ticking it', () => {
    assert.ok(launch.includes("type=\"checkbox\""))
    assert.ok(launch.includes('checked={confirmed}'))
    // Both controls are gated on it.
    assert.ok(launch.includes('const ready = enabled && normalized.ok && confirmed'))
    assert.ok(launch.includes('disabled={!enabled || !normalized.ok || !confirmed || previewing}'))
  })

  test('THE SENTENCE IS THE SAME ON BOTH SIDES, word for word', () => {
    // Two copies of one sentence is how they drift, so they are pinned to each
    // other. The component keeps its own copy rather than importing the route's,
    // because a Client Component must not pull in a module that reads
    // server-only configuration.
    const expected =
      'I confirm this number may receive a draft review from BOE, and that BOE will not publish it anywhere.'
    assert.ok(route.includes(`export const RECIPIENT_CONFIRMATION =\n  '${expected}'`))
    assert.ok(launch.includes(`export const RECIPIENT_CONFIRMATION =\n  '${expected}'`))
  })
})

describe('authorization stays on the server', () => {
  test('`authorize` fails closed on every step', () => {
    const fn = route.slice(route.indexOf('async function authorize'), route.indexOf('export async function POST'))
    assert.ok(fn.includes('if (authError || !user) return { response: fail(401'))
    assert.ok(fn.includes("if (!profile || profile.is_active !== true) return { response: fail(403"))
    assert.ok(fn.includes("p_action_key: 'use'"))
    assert.ok(fn.includes('if (allowed !== true) return { response: fail(403'))
  })

  test('A NON-OWNER CANNOT GENERATE A LINK, AND THERE IS NO ADMIN EXCEPTION', () => {
    // Two checks, and both are needed. RLS lets a VERIFIER read every card, so
    // the read alone would not stop one producing a link for somebody else's
    // test; the ownership check is what does.
    assert.ok(route.includes(".from('customer_review_test_cards')"))
    assert.ok(route.includes('if (!card) return fail(404, MESSAGES.not_found)'))
    assert.ok(route.includes('if (card.booked_by !== caller.userId) return fail(403'))

    // THE ADMIN BRANCH IS GONE, not merely unused. An earlier version read
    // `!caller.isAdmin && card.booked_by !== caller.userId`, which let an
    // administrator open WhatsApp for a test somebody else booked. Checked as an
    // absence, because an ownership check with a disjunct in front of it reads
    // almost identically to one without.
    assert.equal(/isAdmin\s*&&\s*card\.booked_by/.test(route), false,
      'the ownership check still has an administrator escape hatch')

    // ...and no other comparison against booked_by is admitted anywhere in the
    // route, so the check above is the only one there is.
    const comparisons = [...route.matchAll(/card\.booked_by\s*!==\s*[\w.]+/g)].map(m => m[0])
    assert.deepEqual(comparisons, ['card.booked_by !== caller.userId'])
  })

  test('and only while the card is booked', () => {
    assert.ok(route.includes("if (card.status !== 'booked') return fail(409, MESSAGES.wrong_status)"))
  })

  test('the card is read AS THE CALLER, so RLS decides visibility', () => {
    const post = route.slice(route.indexOf('export async function POST'))
    const readAt = post.indexOf(".from('customer_review_test_cards')")
    const clientAt = post.lastIndexOf('await createClient()', readAt)
    assert.ok(clientAt !== -1 && clientAt < readAt, 'the card is not read through the caller')
    // The service role appears only in the recording branch.
    const adminAt = post.indexOf('adminClient()')
    assert.ok(adminAt > readAt, 'the privileged client is built before the card is read')
  })
})

describe('the message, and the label it must carry', () => {
  test('it is composed from the CARD ROW and constants, never from the request', () => {
    assert.ok(route.includes('const message = buildReviewMessage({'))
    assert.ok(route.includes('title: card.test_title'))
    assert.ok(route.includes('body: card.test_body'))
    assert.ok(route.includes('reference: card.card_ref'))
    // Nothing from the body reaches the text.
    assert.equal(/buildInternalTestMessage\([\s\S]{0,200}typedNumber/.test(route), false)
  })

  test('THE LABEL CANNOT BE OVERRIDDEN THROUGH THE PAYLOAD', () => {
    // The request has exactly four fields, and none of them is text.
    const parse = route.slice(route.indexOf('const body = await req.json()'), route.indexOf('if (!confirmed)'))
    const fields = [...parse.matchAll(/fields\.(\w+)/g)].map(m => m[1])
    assert.deepEqual([...new Set(fields)].sort(), ['cardId', 'confirmed', 'number', 'record'])
    for (const forbidden of ['message', 'text', 'warning', 'prefix', 'body', 'template']) {
      assert.equal(fields.includes(forbidden), false, `the payload carries a ${forbidden} field`)
    }
  })

  test('and it is re-checked on the way out', () => {
    assert.ok(route.includes('if (!isSendableReviewMessage(message))'))
    assert.ok(route.includes('refusing to build a message that leaked metadata'))
    // The browser refuses too.
    assert.ok(launch.includes('!isSendableReviewMessage(built.message'))
  })
})

describe('opening is not sending, and previewing is not opening', () => {
  test('RECORDING IS OPT-IN, and the default is not to record', () => {
    assert.ok(route.includes('record = fields.record === true'))
    assert.ok(route.includes('if (record) {'))
    // The preview call does not ask for it.
    const preview = launch.slice(launch.indexOf('const loadPreview = useCallback'), launch.indexOf('const launch = useCallback'))
    assert.equal(preview.includes('record: true'), false)
    assert.ok(preview.includes('JSON.stringify({ cardId, number: typed, confirmed: true })'))
  })

  test('GENERATING OR OPENING A LINK MOVES NO STATUS', () => {
    // Asserted against the SQL, because that is where it is actually true: the
    // RPC has no status assignment at all.
    const fn = /create or replace function public\.record_customer_review_test_card_whatsapp_opened[\s\S]*?\$\$;/
      .exec(sql)?.[0] ?? ''
    assert.ok(fn, 'the RPC is missing')
    for (const chunk of fn.split('update public.customer_review_test_cards').slice(1)) {
      const setClause = chunk.slice(0, chunk.indexOf('where'))
      assert.equal(/\bstatus\s*=/.test(setClause), false, 'opening WhatsApp assigns a status')
    }
    // ...and the route calls nothing that could.
    assert.equal(routeCode.includes('transition_customer_review_test_card'), false)
    assert.equal(routeCode.includes('confirm_customer_review_test_card_sent'), false)
  })

  test('CONFIRMING IS A DIFFERENT CALL, MADE BY A PERSON, ON A DIFFERENT CONTROL', () => {
    assert.ok(launch.includes('export function ConfirmSentControl'))
    const detail = read('src/app/customer-reviews/[id]/TestCardDetailScreen.tsx')
    assert.ok(detail.includes("supabase.rpc('confirm_customer_review_test_card_sent'"))
    assert.ok(detail.includes('onConfirm={confirmSent}'))
  })

  test('the recorder is reachable by service_role alone', () => {
    // THREE PARAMETERS, NOT FOUR. The fingerprint argument is gone along with
    // the column it fed; the signature in the grant is the load-bearing part,
    // because a grant naming a signature that no longer exists is a silent
    // no-op that leaves the function granted to whatever it was before.
    assert.ok(sql.includes(
      'revoke execute on function public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)\n  from public, anon, authenticated;',
    ))
    assert.ok(sql.includes(
      'grant  execute on function public.record_customer_review_test_card_whatsapp_opened(uuid, text, uuid)\n  to service_role;',
    ))
    assert.equal(sql.includes('record_customer_review_test_card_whatsapp_opened(uuid, text, text, uuid)'), false,
      'the four-argument signature is still referenced somewhere')
  })

  test('a recording failure is reported, not swallowed', () => {
    assert.ok(route.includes('if (error) {'))
    assert.ok(route.includes('return fail(500, MESSAGES.record_failed)'))
  })
})

describe('what the route will not leak', () => {
  test('every response is a prewritten sentence, or the validator’s own', () => {
    const messages = route.slice(route.indexOf('const MESSAGES = {'), route.indexOf('} as const'))
    assert.equal(/\$\{/.test(messages), false, 'a message interpolates something')
    for (const call of route.matchAll(/fail\(\d+,\s*([^)]+)\)/g)) {
      assert.ok(
        call[1].startsWith('MESSAGES.') || call[1] === 'normalized.error',
        `a failure returns something other than a fixed sentence: ${call[1]}`,
      )
    }
  })

  test('NO LOG LINE CAN CARRY THE NUMBER', () => {
    for (const line of route.split('\n').filter(l => l.includes('console.'))) {
      assert.equal(/typedNumber|normalized\.(e164|digits)/.test(line), false,
        `a log line references the number: ${line.trim()}`)
    }
  })

  test('and the response carries only the last four', () => {
    assert.ok(route.includes('target: { lastFour: normalized.e164.slice(-4) }'))
  })

  test('nothing is cacheable', () => {
    assert.ok(route.includes("'Cache-Control': 'no-store, private'"))
  })

  test('THE GET HANDLER IS GONE with the list it used to serve', () => {
    // It existed only to hand the approved numbers to the browser. There is no
    // list, so there is nothing to hand over and no endpoint that could.
    assert.equal(route.includes('export async function GET'), false)
  })
})

describe('the screen says what it now does', () => {
  test('it asks the tester to ENTER a number', () => {
    assert.ok(launch.includes('Enter WhatsApp number'))
    assert.equal(launch.includes('approved team number'), false)
    assert.equal(launch.includes('Choose from the approved list'), false)
  })

  test('the field is a free-text tel input, not a picker', () => {
    assert.ok(launch.includes('id="review-recipient-number"'))
    assert.ok(launch.includes('type="tel"'))
    assert.equal(/<select/.test(launch), false, 'the recipient is still chosen from a list')
  })

  test('and it tells the tester what is kept', () => {
    const copy = launch.replace(/\s+/g, ' ')
    assert.ok(copy.includes('Include the country code'))
    assert.ok(copy.includes('only the last four digits are ever stored'))
  })
})
