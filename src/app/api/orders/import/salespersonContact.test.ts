/**
 * THE SALESPERSON'S CONTACT NUMBER, when the workbook did not print one.
 *
 * The number on a BOE PI is BOE's — cell G22, beside the BOE GST at B22 — and
 * it is required before a PI can be submitted. Where the cell is blank the
 * import route fills it from what the system already knows, and this is the
 * rule it uses.
 *
 * WHY THIS HAS ITS OWN TEST FILE. Every failure mode here is SILENT. A wrong
 * filter, a too-eager match or a missed fallback does not throw — it just
 * quietly resolves to null, and the only symptom is somebody typing a number
 * the directory already held. So the query itself is asserted, not only its
 * result.
 *
 *   npx tsx --test src/app/api/orders/import/salespersonContact.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { resolveSalespersonContact } from './process-draft/route'

type UserRow = { full_name: string | null; phone: string | null }

/**
 * Just enough of the PostgREST builder to record what was asked for.
 *
 * Every filter is captured rather than applied, so a test can assert the QUERY
 * — which is where the bug this file exists for would live — and then hand back
 * whatever rows it wants.
 */
function fakeService(input: {
  held?: string | null
  people?: UserRow[]
  usersError?: boolean
}) {
  const filters: string[] = []
  const service = {
    from(table: string) {
      if (table === 'order_submissions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { contact_number: input.held ?? null } }),
            }),
          }),
        }
      }
      if (table === 'users') {
        const builder = {
          select(columns: string) { filters.push(`select:${columns}`); return builder },
          eq(column: string, value: unknown) { filters.push(`eq:${column}=${String(value)}`); return builder },
          neq(column: string, value: unknown) { filters.push(`neq:${column}=${String(value)}`); return builder },
          or(expression: string) { filters.push(`or:${expression}`); return builder },
          ilike(column: string, value: string) { filters.push(`ilike:${column}=${value}`); return builder },
          async limit(n: number) {
            filters.push(`limit:${n}`)
            return input.usersError
              ? { data: null, error: { message: 'boom' } }
              : { data: input.people ?? [], error: null }
          },
        }
        return builder
      }
      throw new Error(`unexpected table ${table}`)
    },
  }
  // The real parameter is a Supabase service client; this stub implements only
  // the two reads the function makes.
  return { service: service as never, filters }
}

const resolve = (
  input: Parameters<typeof fakeService>[0],
  name: string | null,
) => {
  const { service, filters } = fakeService(input)
  return resolveSalespersonContact(service, 'sub-1', name).then(value => ({ value, filters }))
}

describe('the number already on the PI wins', () => {
  test('a held number is returned without the directory being read at all', async () => {
    const { value, filters } = await resolve(
      { held: '+91 98200 11223', people: [{ full_name: 'R. Sharma', phone: '+91 90000 00000' }] },
      'R. Sharma')
    assert.equal(value, '+91 98200 11223')
    assert.deepEqual(filters, [], 'the directory is not queried when the answer is already held')
  })

  test('THIS IS WHAT SURVIVES A RE-UPLOAD', async () => {
    // Somebody corrected the number by hand; re-importing a corrected workbook
    // must not throw that away. The held value is returned whatever the
    // directory says.
    const { value } = await resolve(
      { held: '  +91 98200 11223  ', people: [{ full_name: 'R. Sharma', phone: '+91 90000 00000' }] },
      'R. Sharma')
    assert.equal(value, '+91 98200 11223', 'trimmed, and still the held one')
  })

  test('whitespace is not a held number', async () => {
    const { value } = await resolve(
      { held: '   ', people: [{ full_name: 'R. Sharma', phone: '+91 90000 11111' }] },
      'R. Sharma')
    assert.equal(value, '+91 90000 11111')
  })
})

describe('the directory query', () => {
  test('ACTIVE AND NOT DELETED, with the two-sided NULL check', async () => {
    const { filters } = await resolve({ people: [] }, 'R. Sharma')

    assert.ok(filters.includes('eq:is_active=true'), 'only active employees')

    // THE BUG THIS ASSERTION EXISTS FOR. `.neq('is_deleted', true)` reads as the
    // same rule and is not: in PostgREST that comparison is NULL for a NULL
    // column and the row is filtered OUT — and is_deleted is NULL on every user
    // who has never been deleted. The prefill would have found nobody, silently,
    // on almost every PI.
    assert.ok(filters.includes('or:is_deleted.eq.false,is_deleted.is.null'),
      'a never-deleted user has is_deleted NULL and must still be found')
    assert.ok(!filters.some(f => f.startsWith('neq:is_deleted')),
      'the one-sided comparison excludes NULL and must not be used')
  })

  test('it reads two safe columns, never the whole row', async () => {
    const { filters } = await resolve({ people: [] }, 'R. Sharma')
    assert.ok(filters.includes('select:full_name, phone'),
      'public.users carries HR data this route has no business holding')
  })

  test('and is not run at all without a name to match', async () => {
    for (const name of [null, '', '   ', '—', '-']) {
      const { value, filters } = await resolve({ people: [] }, name)
      assert.equal(value, null, JSON.stringify(name))
      assert.deepEqual(filters, [], JSON.stringify(name))
    }
  })
})

describe('matching a name to a number', () => {
  test('one active employee with that name supplies the number', async () => {
    const { value } = await resolve(
      { people: [{ full_name: 'R. Sharma', phone: '+91 90000 11111' }] }, 'R. Sharma')
    assert.equal(value, '+91 90000 11111')
  })

  test('case and surrounding whitespace do not decide it', async () => {
    const { value } = await resolve(
      { people: [{ full_name: '  r. sharma ', phone: '+91 90000 11111' }] }, 'R. SHARMA  ')
    assert.equal(value, '+91 90000 11111')
  })

  test('A NEAR MATCH IS NOT A MATCH', async () => {
    // The directory answers `ilike`, which can return more than the exact name;
    // the function compares the whole trimmed name itself. A phone number on a
    // client's PI is not a place for a fuzzy match.
    const { value } = await resolve(
      { people: [{ full_name: 'R. Sharman', phone: '+91 90000 11111' }] }, 'R. Sharma')
    assert.equal(value, null)
  })

  test('TWO DIFFERENT NUMBERS IS A TIE, AND A TIE RESOLVES TO NOTHING', async () => {
    // Printing the wrong person's number on a commercial document is worse than
    // printing none and being asked for it.
    const { value } = await resolve({
      people: [
        { full_name: 'R. Sharma', phone: '+91 90000 11111' },
        { full_name: 'R. Sharma', phone: '+91 90000 22222' },
      ],
    }, 'R. Sharma')
    assert.equal(value, null)
  })

  test('two namesakes agreeing on one number is not a tie', async () => {
    // The ambiguity that matters is two NUMBERS, not two rows.
    const { value } = await resolve({
      people: [
        { full_name: 'R. Sharma', phone: '+91 90000 11111' },
        { full_name: 'R. Sharma', phone: ' +91 90000 11111 ' },
      ],
    }, 'R. Sharma')
    assert.equal(value, '+91 90000 11111')
  })

  test('a namesake without a number does not block the one who has it', async () => {
    const { value } = await resolve({
      people: [
        { full_name: 'R. Sharma', phone: null },
        { full_name: 'R. Sharma', phone: '+91 90000 11111' },
      ],
    }, 'R. Sharma')
    assert.equal(value, '+91 90000 11111')
  })

  test('a name the directory does not know resolves to nothing', async () => {
    const { value } = await resolve({ people: [] }, 'Somebody Else')
    assert.equal(value, null)
  })

  test('a failed lookup resolves to nothing rather than throwing', async () => {
    // The draft is saved and correct either way; what is lost is a convenience,
    // and the field is asked for on screen before the PI can be submitted.
    const { value } = await resolve({ usersError: true }, 'R. Sharma')
    assert.equal(value, null)
  })
})
