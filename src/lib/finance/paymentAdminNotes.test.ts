/**
 * THE ADMIN'S PRIVATE NOTE ON A PAYMENT (20270603000000) — the client helpers and
 * the migration's shape. What the database REFUSES (anybody who is not an active
 * admin) is proved by running the migration: supabase/tests/payment_admin_notes_pglite.mjs.
 *
 * Run: npm run test:file -- src/lib/finance/paymentAdminNotes.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  ADMIN_NOTE_MAX,
  loadPaymentAdminNotes,
  paymentAdminNoteErrorMessage,
  paymentAdminNotePreview,
  readPaymentAdminNotes,
  savePaymentAdminNote,
} from './paymentAdminNotes'

const ROOT = process.cwd()
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/20270603000000_finance_payment_admin_notes.sql'), 'utf8')

type Call = { fn: string; args: Record<string, unknown> }
/** A stand-in for the Supabase client: records each rpc and answers as told. */
function fake(answer: { data?: unknown; error?: { code?: string; message: string } | null } | (() => never)) {
  const calls: Call[] = []
  const client = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      if (typeof answer === 'function') return answer()
      return { data: answer.data ?? null, error: answer.error ?? null }
    },
  }
  return { client: client as never, calls }
}

describe('reading the notes', () => {
  test('keeps real notes and leaves out blanks and malformed rows', () => {
    const notes = readPaymentAdminNotes([
      { payment_id: 'a', note: 'Called the client', updated_at: '2026-11-05T10:00:00Z' },
      { payment_id: 'b', note: '   ', updated_at: '2026-11-05T10:00:00Z' },
      { payment_id: 'c' },
      null,
      { note: 'no id' },
    ])
    assert.deepEqual([...notes.keys()], ['a'])
    assert.equal(notes.get('a')?.note, 'Called the client')
    assert.equal(notes.get('a')?.updatedAt, '2026-11-05T10:00:00Z')
    assert.equal(readPaymentAdminNotes(undefined).size, 0)
    assert.equal(readPaymentAdminNotes({ not: 'an array' }).size, 0)
  })

  test('asks the database once, by id; nothing to ask means no call', async () => {
    const { client, calls } = fake({ data: [{ payment_id: 'a', note: 'n', updated_at: 't' }] })
    const notes = await loadPaymentAdminNotes(client, ['a', 'b'])
    assert.deepEqual(calls, [{ fn: 'get_payment_admin_notes', args: { p_payment_ids: ['a', 'b'] } }])
    assert.equal(notes.get('a')?.note, 'n')
    const none = fake({ data: [] })
    assert.equal((await loadPaymentAdminNotes(none.client, [])).size, 0)
    assert.equal(none.calls.length, 0)
  })

  test('a failed read THROWS: it is never taken for "no notes"', async () => {
    const { client } = fake({ error: { message: 'ADMIN_NOTE_ADMIN_ONLY: only an administrator' } })
    await assert.rejects(() => loadPaymentAdminNotes(client, ['a']))
  })
})

describe('saving a note', () => {
  test('sends the trimmed text and returns when it was saved', async () => {
    const { client, calls } = fake({ data: '2026-11-05T10:15:00+00:00' })
    const result = await savePaymentAdminNote(client, 'pay-1', '  Waiting for Monday  ')
    assert.deepEqual(calls, [{ fn: 'set_payment_admin_note', args: { p_payment_id: 'pay-1', p_note: 'Waiting for Monday' } }])
    assert.deepEqual(result, { ok: true, note: { note: 'Waiting for Monday', updatedAt: '2026-11-05T10:15:00+00:00' } })
  })

  test('an empty text removes the note (the result carries no note)', async () => {
    const { client, calls } = fake({ data: null })
    const result = await savePaymentAdminNote(client, 'pay-1', '   \n ')
    assert.equal(calls[0].args.p_note, '')
    assert.deepEqual(result, { ok: true, note: null })
  })

  test('a note over the limit is refused before anything is sent', async () => {
    const { client, calls } = fake({ data: 'x' })
    const result = await savePaymentAdminNote(client, 'pay-1', 'x'.repeat(ADMIN_NOTE_MAX + 1))
    assert.equal(result.ok, false)
    assert.equal(calls.length, 0)
    assert.equal((await savePaymentAdminNote(fake({ data: 't' }).client, 'pay-1', 'x'.repeat(ADMIN_NOTE_MAX))).ok, true)
  })

  test('a refusal comes back as a sentence, and nothing is saved on screen', async () => {
    const refused = await savePaymentAdminNote(fake({ error: { message: 'ADMIN_NOTE_ADMIN_ONLY: only an administrator can write payment notes', code: '42501' } }).client, 'p', 'x')
    assert.deepEqual(refused, { ok: false, message: 'Only an administrator can read or write these notes.' })
    const thrown = await savePaymentAdminNote(fake(() => { throw new Error('network down') }).client, 'p', 'x')
    assert.equal(thrown.ok, false)
  })

  test('each database refusal has its own sentence', () => {
    assert.match(paymentAdminNoteErrorMessage({ message: 'ADMIN_NOTE_TOO_LONG: a note can be at most 2,000 characters' }), /at most 2,000 characters/)
    assert.match(paymentAdminNoteErrorMessage({ message: 'ADMIN_NOTE_PAYMENT_NOT_FOUND: that payment does not exist' }), /no longer exists/)
    assert.match(paymentAdminNoteErrorMessage({ code: 'PGRST202', message: 'Could not find the function' }), /not switched on yet/)
    assert.match(paymentAdminNoteErrorMessage({ code: '42883', message: 'function does not exist' }), /not switched on yet/)
    assert.match(paymentAdminNoteErrorMessage({ message: 'something unexpected' }), /could not be saved/)
    assert.match(paymentAdminNoteErrorMessage(null), /could not be saved/)
  })
})

describe('the hover preview', () => {
  test('is one line, and cut with an ellipsis when long', () => {
    assert.equal(paymentAdminNotePreview('Called\n\nthe   client'), 'Called the client')
    const long = paymentAdminNotePreview('word '.repeat(100), 40)
    assert.ok(long.length <= 40 && long.endsWith('…'), long)
  })
})

describe('the migration', () => {
  test('is in the folder, and adds one table and two doors', () => {
    const names = readdirSync(join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort()
    // Not "is the last file": any later migration would break that without touching this one.
    assert.ok(names.includes('20270603000000_finance_payment_admin_notes.sql'))
    assert.equal((MIGRATION.match(/^create table /gm) ?? []).length, 1)
    assert.match(MIGRATION, /create or replace function public\.get_payment_admin_notes\(/)
    assert.match(MIGRATION, /create or replace function public\.set_payment_admin_note\(/)
  })

  test('the table has RLS on, no policy, and no grant for any client role', () => {
    assert.match(MIGRATION, /alter table public\.finance_payment_admin_notes enable row level security/)
    assert.equal(/create policy/i.test(MIGRATION), false, 'the functions are the only door')
    assert.match(MIGRATION, /revoke all on table public\.finance_payment_admin_notes from public, anon, authenticated/)
    assert.equal(/grant\s+(select|insert|update|delete|all)[^;]*finance_payment_admin_notes/i.test(MIGRATION), false)
  })

  test('both doors check the admin role first, run as the owner with a fixed search_path, and refuse anon', () => {
    for (const fn of ['get_payment_admin_notes', 'set_payment_admin_note']) {
      // From the definition (the header's rollback note names the same functions).
      const body = MIGRATION.slice(MIGRATION.indexOf(`create or replace function public.${fn}(`))
      const upToNext = body.slice(0, body.indexOf('$fn$;', body.indexOf('$fn$') + 4))
      assert.match(upToNext, /security definer/)
      assert.match(upToNext, /set search_path = public, pg_temp/)
      const check = upToNext.indexOf('finance_admin_note_caller_is_admin()')
      assert.ok(check > 0, `${fn} calls the admin check`)
      assert.ok(check < upToNext.indexOf('ADMIN_NOTE_ADMIN_ONLY'), `${fn} checks before it refuses, and before any read or write`)
      assert.ok(check < upToNext.indexOf('finance_payment_admin_notes'), `${fn} touches the table only after the check`)
    }
    assert.match(MIGRATION, /revoke execute on function public\.get_payment_admin_notes\(uuid\[\]\) from public, anon;/)
    assert.match(MIGRATION, /revoke execute on function public\.set_payment_admin_note\(uuid, text\) from public, anon;/)
    assert.match(MIGRATION, /revoke execute on function public\.finance_admin_note_caller_is_admin\(\) from public, anon, authenticated;/)
  })

  test('the admin means an ACTIVE, not-deleted user whose role is admin; nothing else', () => {
    const helper = MIGRATION.slice(MIGRATION.indexOf('create or replace function public.finance_admin_note_caller_is_admin'), MIGRATION.indexOf('revoke execute on function public.finance_admin_note_caller_is_admin'))
    assert.match(helper, /u\.role = 'admin'/)
    assert.match(helper, /u\.is_active/)
    assert.match(helper, /is_deleted/)
    assert.equal(/actor_has_module_permission|actor_has_permission|finance\./.test(helper), false, 'a Finance grant must never read these notes')
  })

  test('a deleted payment takes its note with it, and a removed user does not block anything', () => {
    assert.match(MIGRATION, /payment_id uuid primary key references public\.finance_payment_requests \(id\) on delete cascade/)
    assert.match(MIGRATION, /updated_by uuid references public\.users \(id\) on delete set null/)
  })

  test('it changes no existing table, function or policy', () => {
    assert.equal(/alter table public\.(?!finance_payment_admin_notes)/i.test(MIGRATION), false)
    assert.equal(/create or replace function public\.(?!get_payment_admin_notes|set_payment_admin_note|finance_admin_note_caller_is_admin)/i.test(MIGRATION), false)
    assert.equal(/\b(insert into|update|delete from) public\.(?!finance_payment_admin_notes)/i.test(MIGRATION.replace(/--.*$/gm, '')), false)
  })
})

describe('where the note can and cannot appear', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (/\.(ts|tsx)$/.test(name)) out.push(p)
    }
    return out
  }

  test('no screen reads or writes the table itself: only the two functions are called', () => {
    const offenders = walk(join(ROOT, 'src'))
      .filter(f => !/paymentAdminNotes\.test\.ts$/.test(f))
      // (The migration ledgers name the file 2027…_finance_payment_admin_notes.sql; that is not the table.)
      .filter(f => /finance_payment_admin_notes(?!\.sql)/.test(readFileSync(f, 'utf8')))
    assert.deepEqual(offenders, [])
  })

  test('the Finance decision note and the private note stay two different things', () => {
    const lib = readFileSync(join(ROOT, 'src/lib/finance/paymentAdminNotes.ts'), 'utf8')
    assert.equal(/\badmin_note\b/.test(lib.replace(/\/\/.*$/gm, '')), false, 'the private note never touches finance_payment_requests.admin_note')
    const view = readFileSync(join(ROOT, 'src/lib/finance/piPaymentView.ts'), 'utf8')
    assert.equal(view.includes('get_payment_admin_notes'), false)
  })

  test('the page asks for the notes only for an admin, and hands the controls to nobody else', () => {
    const page = readFileSync(join(ROOT, 'src/app/finance/page.tsx'), 'utf8')
    assert.match(page, /if \(!isAdmin\) return ''/)
    assert.match(page, /!isAdmin \? undefined : notesState/)
    assert.match(page, /onAdminNote=\{isAdmin \? setNoteFor : undefined\}/)
    assert.match(page, /isAdmin && noteFor && adminNotes !== undefined/)
  })
})
