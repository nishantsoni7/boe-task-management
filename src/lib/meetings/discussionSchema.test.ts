/**
 * Repository check: the order-discussion migration keeps the guarantees the whole
 * workflow is built on.
 *
 * Each of these fails SILENTLY if somebody later "fixes" the schema by adding the
 * obvious missing policy, and TypeScript cannot see any of it:
 *
 *   1. ONE ITEM, ONE MEETING, ONCE. Automatic carry-forward is idempotent only
 *      because of a UNIQUE constraint and ON CONFLICT DO NOTHING. Drop either and
 *      a retried meeting creation produces a duplicate agenda row — with every
 *      screen still working.
 *   2. ONE OPEN ISSUE PER SOURCE TASK. Pressing Add to Meeting twice is safe only
 *      because of a partial unique index. Without it the RPC's read-then-insert is
 *      a race.
 *   3. THE TRAIL IS APPEND-ONLY, and no client role can write any of the three
 *      tables. Every mutation goes through a definer function that writes the row
 *      and its trail entry in ONE transaction.
 *   4. EVERY WRITE PATH AUTHORIZES FIRST, and a completed meeting is read-only
 *      because assert_meeting_editor() refuses it.
 *   5. CATEGORY AND STATE ARE THE DATABASE'S RULES, not the browser's, and an
 *      after-sales tag cannot attach to a running-order item.
 *   6. NOTHING SHIPPED WAS CHANGED. add_meeting_order_evidence() keeps its exact
 *      signature, the evidence table stays append-only, and the new column is
 *      nullable so every existing row is still valid.
 *
 * Structure only — the migration's own DO-block assertions are what an APPLY
 * executes; these keep the text from drifting before it gets there. See
 * reference: a text test can pass while an apply aborts.
 *
 * Run:
 *   npx tsx --test src/lib/meetings/discussionSchema.test.ts
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(process.cwd(), 'supabase', 'migrations')

/** Located by content rather than by a pinned filename. */
function discussionMigration(): { file: string; sql: string } {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(file => ({ file, sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8') }))
    .filter(({ sql }) => /CREATE TABLE IF NOT EXISTS public\.meeting_discussion_items/.test(sql))

  assert.equal(candidates.length, 1, 'expected exactly one migration creating the discussion tables')
  return candidates[0]
}

const { file, sql } = discussionMigration()

/**
 * The migration with `--` comments removed. Needed because this file's subject
 * matter appears in the migration's own prose, and a check that scanned the raw
 * text would pass on a sentence promising the thing it is verifying.
 */
const code = sql.replace(/--[^\n]*/g, '')

const DISCUSSION_TABLES = [
  'meeting_discussion_items',
  'meeting_discussion_appearances',
  'meeting_discussion_events',
]

/** The body of one function, for assertions about what it does and in what order. */
function fnBody(name: string): string {
  const match = code.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`))
  assert.ok(match, `${name} not found in the migration`)
  return match[0]
}

/** Policies declared here, as `{ name, table, command, restrictive }`. */
function policies(): { name: string; table: string; command: string; restrictive: boolean }[] {
  const out: { name: string; table: string; command: string; restrictive: boolean }[] = []
  const re = /CREATE POLICY\s+"([^"]+)"\s+ON\s+public\.(\w+)\s+(AS\s+RESTRICTIVE\s+)?FOR\s+(\w+)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(code)) !== null) {
    out.push({ name: match[1], table: match[2], restrictive: !!match[3], command: match[4].toUpperCase() })
  }
  return out
}

/** The CREATE TABLE block for one table. */
function tableBlock(name: string): string {
  const match = code.match(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${name} \\([\\s\\S]*?\\n\\);`))
  assert.ok(match, `${name} table not found`)
  return match[0]
}

// ─── 0. It is a new, forward-only migration ──────────────────────────────────

describe('the migration is additive and forward-only', () => {
  test('it comes after every migration that already exists', () => {
    const versions = readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .map(f => f.slice(0, 14))
      .filter(v => /^\d{14}$/.test(v))
      .sort()
    assert.equal(file.slice(0, 14), versions[versions.length - 1],
      'a new migration must be the last version, so nothing already applied is re-ordered')
  })

  test('it drops no table, column or existing policy', () => {
    // DROP POLICY IF EXISTS on a policy this file also creates is the module's own
    // re-emit idiom and is fine; dropping anything else is not.
    const drops = [...code.matchAll(/DROP\s+(TABLE|COLUMN|FUNCTION|CONSTRAINT)\b[^\n;]*/gi)].map(m => m[0])
    assert.deepEqual(drops, [], `unexpected drop: ${drops.join(' | ')}`)

    const droppedPolicies = [...code.matchAll(/DROP POLICY IF EXISTS "([^"]+)"/g)].map(m => m[1])
    const createdPolicies = policies().map(p => p.name)
    for (const name of droppedPolicies) {
      assert.ok(createdPolicies.includes(name), `${name} is dropped but not re-created`)
    }
  })

  test('the only ALTER TABLE is the one nullable evidence column', () => {
    const alters = [...code.matchAll(/ALTER TABLE public\.(\w+)\s+([A-Z ]+)/g)]
      .map(m => `${m[1]} ${m[2].trim().replace(/ IF NOT EXISTS$/, '')}`)
      .filter(entry => !entry.endsWith('ENABLE ROW LEVEL SECURITY'))
    assert.deepEqual(alters, ['meeting_order_evidence ADD COLUMN'])
    assert.match(code, /ADD COLUMN IF NOT EXISTS discussion_appearance_id uuid/)
    // Nullable: every row written before this migration stays valid, which is why
    // no backfill is needed.
    assert.ok(!/discussion_appearance_id uuid[\s\S]{0,80}NOT NULL/.test(code))
  })

  test('there is no backfill, and the header says why', () => {
    assert.ok(!/INSERT INTO public\.meeting_discussion_items/.test(
      code.replace(/CREATE OR REPLACE FUNCTION[\s\S]*/, '')),
      'nothing outside the functions inserts an issue')
    assert.match(sql, /There is NO backfill/i)
  })
})

// ─── 1. Duplicate prevention ─────────────────────────────────────────────────

describe('one item can appear in one meeting exactly once', () => {
  test('the UNIQUE constraint exists on (meeting_id, discussion_item_id)', () => {
    assert.match(
      tableBlock('meeting_discussion_appearances'),
      /CONSTRAINT meeting_discussion_appearances_unique_per_meeting\s*\n?\s*UNIQUE \(meeting_id, discussion_item_id\)/,
    )
  })

  test('every insert into an agenda targets that constraint with DO NOTHING', () => {
    const inserts = [...code.matchAll(
      /INSERT INTO public\.meeting_discussion_appearances[\s\S]*?(?:RETURNING|;)/g,
    )].map(m => m[0])
    assert.ok(inserts.length >= 2, 'expected the attach and the carry-forward inserts')
    for (const statement of inserts) {
      assert.match(
        statement,
        /ON CONFLICT ON CONSTRAINT meeting_discussion_appearances_unique_per_meeting DO NOTHING/,
        'an agenda insert without DO NOTHING makes a retry fail instead of being a no-op',
      )
    }
  })

  test('carry-forward is idempotent: a conflict is skipped, not counted, not logged', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    assert.match(body, /ON CONFLICT ON CONSTRAINT meeting_discussion_appearances_unique_per_meeting DO NOTHING/)
    // The conflict path must CONTINUE before the counter and the event write.
    const conflict = body.indexOf('IF v_appearance.id IS NULL THEN')
    const counter  = body.indexOf('v_added := v_added + 1')
    const event    = body.indexOf('record_meeting_discussion_event')
    assert.ok(conflict > -1 && conflict < counter && conflict < event)
    assert.match(body, /CONTINUE;/)
  })

  test('attaching an item twice returns the existing row rather than raising', () => {
    const body = fnBody('attach_meeting_discussion_item')
    assert.match(body, /IF v_appearance\.id IS NULL THEN[\s\S]*?SELECT \* INTO v_appearance[\s\S]*?RETURN v_appearance;/)
  })
})

describe('one task can raise one open issue', () => {
  test('a partial unique index enforces it in the database, not in the button', () => {
    assert.match(
      code,
      /CREATE UNIQUE INDEX IF NOT EXISTS meeting_discussion_items_one_open_per_task_idx\s*\n\s*ON public\.meeting_discussion_items \(source_task_id\)\s*\n\s*WHERE source_task_id IS NOT NULL AND state = 'open'/,
    )
  })

  test('capture reads the existing open item before it inserts, and locks it', () => {
    const body = fnBody('capture_meeting_discussion_item')
    const read   = body.indexOf('WHERE source_task_id = p_source_task_id AND state = \'open\'')
    const insert = body.indexOf('INSERT INTO public.meeting_discussion_items')
    assert.ok(read > -1 && insert > read, 'the duplicate check must precede the insert')
    assert.match(body.slice(read, insert), /FOR UPDATE/, 'a concurrent caller must wait, not collide')
  })

  test('and a lost race still returns the other caller’s item instead of an error', () => {
    const body = fnBody('capture_meeting_discussion_item')
    assert.match(body, /EXCEPTION\s*\n\s*WHEN unique_violation THEN/)
    assert.match(body, /'status', 'existing'/)
  })
})

// ─── 2. Append-only, and no client writes ────────────────────────────────────

describe('the three tables are readable and nothing else', () => {
  for (const table of DISCUSSION_TABLES) {
    test(`${table} has RLS enabled`, () => {
      assert.match(code, new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`))
    })

    test(`${table} has exactly one permissive policy, and it is SELECT`, () => {
      const own = policies().filter(p => p.table === table && !p.restrictive)
      assert.equal(own.length, 1, `${table} has ${own.length} permissive policies`)
      assert.equal(own[0].command, 'SELECT')
    })

    test(`${table} carries the RESTRICTIVE module entry gate`, () => {
      const gate = policies().find(p => p.name === `${table}_module_entry_gate`)
      assert.ok(gate, `${table} is missing its gate`)
      assert.ok(gate!.restrictive, 'a PERMISSIVE gate would GRANT access rather than restrict it')
      assert.equal(gate!.command, 'ALL')
    })

    test(`${table} has every write privilege revoked from authenticated and anon`, () => {
      assert.match(code, new RegExp(
        `REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\\.${table}\\s+FROM authenticated`,
      ))
      assert.match(code, new RegExp(`REVOKE ALL ON public\\.${table}\\s+FROM anon`))
      if (table === 'meeting_discussion_items') {
        // Column by column, and never resolution_note (see "meeting notes follow the meeting").
        assert.match(code, /REVOKE SELECT ON public\.meeting_discussion_items FROM authenticated;/)
        assert.match(code, /GRANT SELECT \(\s*id, category,[\s\S]*?resolved_at, resolved_by\s*\) ON public\.meeting_discussion_items TO authenticated/)
      } else {
        assert.match(code, new RegExp(`GRANT SELECT ON public\\.${table}\\s+TO authenticated`))
      }
    })
  }

  test('no policy anywhere in this migration is USING (true)', () => {
    assert.ok(!/USING\s*\(\s*true\s*\)/i.test(code))
  })

  test('the trail has no UPDATE or DELETE path of any kind', () => {
    const eventPolicies = policies().filter(p => p.table === 'meeting_discussion_events')
    for (const policy of eventPolicies) {
      assert.ok(['SELECT', 'ALL'].includes(policy.command), `${policy.name} is ${policy.command}`)
    }
    assert.ok(!/UPDATE public\.meeting_discussion_events/.test(code))
    assert.ok(!/DELETE FROM public\.meeting_discussion_events/.test(code))
  })

  test('nothing deletes a discussion item or an appearance', () => {
    assert.ok(!/DELETE FROM public\.meeting_discussion_items/.test(code))
    assert.ok(!/DELETE FROM public\.meeting_discussion_appearances/.test(code))
  })
})

describe('the internal writers are unreachable from a client', () => {
  for (const fn of ['record_meeting_discussion_event', 'apply_meeting_discussion_carry_forward']) {
    test(`${fn} is revoked from authenticated as well as anon`, () => {
      assert.match(code, new RegExp(
        `REVOKE EXECUTE ON FUNCTION public\\.${fn}\\([\\s\\S]{0,240}?\\)\\s*\\n?\\s*FROM public, anon, authenticated`,
      ))
      assert.ok(!new RegExp(`GRANT\\s+EXECUTE ON FUNCTION public\\.${fn}\\b[^;]*TO authenticated`).test(code),
        `${fn} must never be granted to a client role`)
    })
  }

  test('the appearance-order validation trigger is not callable either', () => {
    assert.match(code, /REVOKE EXECUTE ON FUNCTION public\.meeting_discussion_appearance_order_in_meeting\(\)\s*\n?\s*FROM public, anon, authenticated/)
  })
})

// ─── 3. Every write authorizes first ─────────────────────────────────────────

describe('authorization comes before the write, in every path', () => {
  const appearanceScoped = [
    'save_meeting_discussion_update',
    'resolve_meeting_discussion_item',
    'link_meeting_discussion_task',
    'ensure_meeting_discussion_order',
    'add_meeting_discussion_evidence',
  ]

  for (const fn of appearanceScoped) {
    test(`${fn} authorizes through assert_meeting_discussion_editor before it writes`, () => {
      const body = fnBody(fn)
      const guard = body.indexOf('assert_meeting_discussion_editor')
      assert.ok(guard > -1, `${fn} does not authorize`)
      const firstWrite = Math.min(
        ...[
          body.indexOf('UPDATE public.'),
          body.indexOf('INSERT INTO public.'),
          body.indexOf('record_meeting_discussion_event'),
        ].filter(i => i > -1),
      )
      assert.ok(guard < firstWrite, `${fn} writes before it authorizes`)
    })
  }

  test('assert_meeting_discussion_editor refuses a completed meeting', () => {
    // It calls assert_meeting_editor with the DEFAULT p_allow_completed (false),
    // which is what makes a completed meeting read-only for the whole workflow.
    const body = fnBody('assert_meeting_discussion_editor')
    assert.match(body, /RETURN public\.assert_meeting_editor\(v_appearance\.meeting_id\);/)
    assert.ok(!/assert_meeting_editor\([^)]*true/.test(body),
      'allowing a completed meeting here would make every write reach one')
  })

  test('attach and carry-forward-on-demand authorize on the MEETING', () => {
    assert.match(fnBody('attach_meeting_discussion_item'), /public\.assert_meeting_editor\(p_meeting_id\)/)
    assert.match(fnBody('carry_forward_meeting_discussions'), /public\.assert_meeting_editor\(p_meeting_id\)/)
  })

  test('reopen authorizes on a meeting the item has been on, completed or not', () => {
    // The one place p_allow_completed is true: the meeting that resolved an issue is
    // usually closed by the time the repair turns out not to have held. Nothing in
    // that meeting changes — the reopen writes to the ISSUE.
    const body = fnBody('reopen_meeting_discussion_item')
    assert.match(body, /can_edit_meeting\(a\.meeting_id, v_uid, true\)/)
    assert.match(body, /MEETING_FORBIDDEN/)
    // And it writes nothing to any meeting.
    assert.ok(!/UPDATE public\.meetings/.test(body))
    assert.ok(!/UPDATE public\.meeting_discussion_appearances/.test(body))
  })

  test('capture checks the MEETINGS half and the TASK half independently', () => {
    const body = fnBody('capture_meeting_discussion_item')
    assert.match(body, /module_entry_open\('meetings'\)/)
    // The task predicate: creator, assignee or admin. Without it a caller could pin
    // any task id in the company to an issue and read it back.
    assert.match(body, /t\.created_by\s*= v_uid/)
    assert.match(body, /t\.assigned_to = v_uid/)
    assert.match(body, /MEETING_TASK_NOT_LINKABLE/)
  })

  test('a task link uses the same task predicate as the shipped SKU link', () => {
    const body = fnBody('link_meeting_discussion_task')
    assert.match(body, /t\.created_by\s*= v_uid/)
    assert.match(body, /t\.assigned_to = v_uid/)
    assert.match(body, /MEETING_TASK_NOT_LINKABLE/)
  })

  test('every client-callable function is granted to authenticated and revoked from anon', () => {
    const clientCallable = [
      'capture_meeting_discussion_item',
      'attach_meeting_discussion_item',
      'save_meeting_discussion_update',
      'resolve_meeting_discussion_item',
      'reopen_meeting_discussion_item',
      'link_meeting_discussion_task',
      'ensure_meeting_discussion_order',
      'add_meeting_discussion_evidence',
      'carry_forward_meeting_discussions',
    ]
    for (const fn of clientCallable) {
      assert.match(code, new RegExp(`REVOKE EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*FROM public, anon`), fn)
      assert.match(code, new RegExp(`GRANT\\s+EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*TO authenticated`), fn)
    }
  })

  test('every function pins its search_path and runs as definer', () => {
    const declarations = [...code.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\([\s\S]*?\$\$;/g)]
    assert.ok(declarations.length >= 10)
    for (const [body, name] of declarations.map(m => [m[0], m[1]] as const)) {
      assert.match(body, /SET search_path = public, pg_temp/, `${name} does not pin search_path`)
      if (name === 'meeting_discussion_category_for_type') {
        // The one exception, and it must stay one: a pure mapping that reads no
        // table. Definer rights there would be privilege with nothing to use it on.
        assert.match(body, /LANGUAGE sql\s*\n\s*IMMUTABLE/, `${name} must stay a pure IMMUTABLE function`)
        assert.ok(!/SECURITY DEFINER/.test(body), `${name} needs no definer rights`)
        assert.ok(!/\bFROM\b/i.test(body), `${name} must not read a table`)
        continue
      }
      assert.match(body, /SECURITY DEFINER/, `${name} is not SECURITY DEFINER`)
    }
  })
})

// ─── 4. Resolve and reopen ───────────────────────────────────────────────────

describe('resolving records a note, an actor and a time', () => {
  test('a blank note is refused', () => {
    const body = fnBody('resolve_meeting_discussion_item')
    assert.match(body, /MEETING_DISCUSSION_NOTE_REQUIRED/)
  })

  test('the CHECK constraint makes a noteless resolution impossible even so', () => {
    assert.match(
      tableBlock('meeting_discussion_items'),
      /CONSTRAINT meeting_discussion_items_resolution_consistent CHECK \([\s\S]*?state = 'resolved'[\s\S]*?resolved_at IS NOT NULL[\s\S]*?resolved_by IS NOT NULL[\s\S]*?btrim\(COALESCE\(resolution_note, ''\)\) <> ''/,
    )
  })

  test('an open issue claims no resolution — the other half of the same CHECK', () => {
    assert.match(
      tableBlock('meeting_discussion_items'),
      /state = 'open'[\s\S]*?resolved_at IS NULL[\s\S]*?resolved_by IS NULL[\s\S]*?resolution_note IS NULL/,
    )
  })

  test('resolving twice is a no-op rather than a second resolution', () => {
    assert.match(fnBody('resolve_meeting_discussion_item'),
      /IF v_item\.state = 'resolved' THEN\s*\n\s*RETURN v_item;/)
  })

  test('resolving writes a trail row with the state transition on it', () => {
    const body = fnBody('resolve_meeting_discussion_item')
    assert.match(body, /'resolved', v_uid,\s*\n\s*p_previous_state := 'open',\s*\n\s*p_new_state\s*:= 'resolved'/)
  })
})

describe('reopening keeps the first resolution', () => {
  test('a blank reason is refused', () => {
    assert.match(fnBody('reopen_meeting_discussion_item'), /MEETING_DISCUSSION_REASON_REQUIRED/)
  })

  test('the reopen event carries the note the issue was resolved with', () => {
    // resolved_at/by/note are CURRENT state and the CHECK forces them to NULL on an
    // open issue, so the ONLY place the first resolution survives is the trail.
    const body = fnBody('reopen_meeting_discussion_item')
    assert.match(body, /p_previous_update := v_item\.resolution_note/)
    assert.match(body, /p_previous_state\s*:= 'resolved'/)
    assert.match(body, /p_new_state\s*:= 'open'/)
  })

  test('reopening twice is a no-op', () => {
    assert.match(fnBody('reopen_meeting_discussion_item'),
      /IF v_item\.state = 'open' THEN\s*\n\s*RETURN v_item;/)
  })
})

// ─── 5. Category and state are the database's rules ──────────────────────────

describe('the category and the state live in CHECK constraints', () => {
  test('exactly two categories', () => {
    assert.match(tableBlock('meeting_discussion_items'),
      /category\s+text NOT NULL CHECK \(category IN \('running_order', 'after_sales'\)\)/)
  })

  test('exactly two states, and no task state among them', () => {
    const block = tableBlock('meeting_discussion_items')
    assert.match(block, /state text NOT NULL DEFAULT 'open' CHECK \(state IN \('open', 'resolved'\)\)/)
    for (const taskState of ['pending', 'working', 'blocked', 'waiting']) {
      assert.ok(!block.includes(`'${taskState}'`), `${taskState} is a TASK state and must not be here`)
    }
  })

  test('an after-sales tag cannot attach to a running-order item', () => {
    assert.match(tableBlock('meeting_discussion_items'),
      /CONSTRAINT meeting_discussion_items_tag_is_after_sales_only CHECK \(\s*\n?\s*after_sales_tag IS NULL OR category = 'after_sales'\s*\n?\s*\)/)
  })

  test('the four tags are constrained too', () => {
    assert.match(tableBlock('meeting_discussion_items'),
      /after_sales_tag IN \('repair', 'replacement', 'site_issue', 'other'\)/)
  })

  test('the RPCs re-check both, because a client is not a validator', () => {
    const body = fnBody('capture_meeting_discussion_item')
    assert.match(body, /MEETING_DISCUSSION_CATEGORY_INVALID/)
    assert.match(body, /MEETING_DISCUSSION_TAG_INVALID/)
  })
})

// ─── 6. Carry-forward's own promises ─────────────────────────────────────────

describe('automatic carry-forward', () => {
  test('is attached to meeting creation by an AFTER INSERT trigger', () => {
    assert.match(code, /CREATE TRIGGER meetings_carry_forward_discussions_trg\s*\n\s*AFTER INSERT ON public\.meetings\s*\n\s*FOR EACH ROW EXECUTE FUNCTION public\.meetings_carry_forward_discussions\(\)/)
  })

  test('runs in the creating transaction, as the meeting’s own creator', () => {
    assert.match(fnBody('meetings_carry_forward_discussions'),
      /apply_meeting_discussion_carry_forward\(NEW\.id, NEW\.created_by\)/)
  })

  test('takes only OPEN items of the matching category', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    assert.match(body, /i\.state = 'open'/)
    assert.match(body, /i\.category = v_category/)
    // The category comes from the ONE mapping every placing path shares…
    assert.match(body, /v_category := public\.meeting_discussion_category_for_type\(v_meeting\.meeting_type\)/)
    // …and a type with no category matches nothing, leaving the Inbox untouched.
    assert.match(body, /IF v_category IS NULL THEN RETURN 0; END IF;/)
    const mapping = fnBody('meeting_discussion_category_for_type')
    assert.match(mapping, /WHEN 'new_order'\s+THEN 'running_order'/)
    assert.match(mapping, /WHEN 'repair_order' THEN 'after_sales'/)
    assert.ok(!/ELSE/.test(mapping), 'an unknown type must map to NULL, never to a default category')
  })

  test('manual attach uses the same mapping, and refuses a mismatch', () => {
    const body = fnBody('attach_meeting_discussion_item')
    assert.match(body, /meeting_discussion_category_for_type\(v_meeting\.meeting_type\)/)
    assert.match(body, /MEETING_DISCUSSION_CATEGORY_MISMATCH/)
    // Refused BEFORE anything is inserted.
    assert.ok(body.indexOf('MEETING_DISCUSSION_CATEGORY_MISMATCH') < body.indexOf('INSERT INTO public.meeting_discussion_appearances'))
  })

  test('an Inbox item only enters a meeting dated on or after the day it was raised', () => {
    assert.match(fnBody('apply_meeting_discussion_carry_forward'),
      /\(i\.created_at AT TIME ZONE 'Asia\/Kolkata'\)::date <= v_meeting\.meeting_date/)
  })

  test('a repeat capture reports where an existing issue really is', () => {
    const body = fnBody('capture_meeting_discussion_item')
    assert.match(body, /'meeting_id',\s+COALESCE\(v_appearance\.meeting_id, v_latest_meeting\)/)
    assert.match(body, /'on_agenda',\s+v_on_agenda/)
    assert.match(body, /'in_inbox',\s+NOT v_on_agenda/)
  })

  test('…but never names a meeting the caller cannot open', () => {
    const body = fnBody('capture_meeting_discussion_item')
    // Both lookups of the "latest meeting": the normal path and the race handler.
    const lookups = body.match(/SELECT a\.meeting_id INTO v_latest_meeting[\s\S]*?LIMIT 1;/g) ?? []
    assert.equal(lookups.length, 2)
    for (const lookup of lookups) {
      assert.match(lookup, /public\.can_view_meeting\(a\.meeting_id, v_uid\)/)
    }
  })

  test('only from meetings HELD BEFORE this one, of the same type', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    assert.match(body, /\(m\.meeting_date, m\.created_at\) < \(v_meeting\.meeting_date, v_meeting\.created_at\)/)
    assert.match(body, /m\.meeting_type = v_meeting\.meeting_type/)
    assert.match(body, /m\.id <> p_meeting_id/)
  })

  test('takes the item’s MOST RECENT earlier appearance, not all of them', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    assert.match(body, /row_number\(\) OVER \(\s*\n?\s*PARTITION BY a\.discussion_item_id/)
    assert.match(body, /WHERE rn = 1/)
  })

  test('also brings in Inbox items — open issues with no appearance anywhere', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    assert.match(body, /NOT EXISTS \(\s*\n\s*SELECT 1 FROM public\.meeting_discussion_appearances a\s*\n\s*WHERE a\.discussion_item_id = i\.id/)
  })

  test('never writes to any meeting other than the new one', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    const writes = [...body.matchAll(/(INSERT INTO|UPDATE) public\.(\w+)/g)].map(m => m[2])
    assert.deepEqual([...new Set(writes)], ['meeting_discussion_appearances'])
    assert.match(body, /VALUES \(\s*\n\s*p_meeting_id,/)
    // Nothing reopens, re-completes or edits the previous meeting.
    assert.ok(!/set_meeting_status/.test(body))
    assert.ok(!/UPDATE public\.meetings/.test(body))
  })

  test('copies no earlier update, decision, review date or image', () => {
    const body = fnBody('apply_meeting_discussion_carry_forward')
    for (const column of ['latest_update', 'decision', 'next_review_date', 'discussed_at']) {
      assert.ok(!body.includes(column),
        `${column} must not be copied forward — an inherited item starts empty`)
    }
  })

  test('refuses to add anything to a completed meeting', () => {
    assert.match(fnBody('apply_meeting_discussion_carry_forward'),
      /IF v_meeting\.status = 'completed' THEN RETURN 0; END IF;/)
  })

  test('preserves the previous agenda order, with Inbox items after it', () => {
    assert.match(fnBody('apply_meeting_discussion_carry_forward'), /ORDER BY 3 NULLS LAST, 1/)
  })

  test('the appearance records where it was inherited from', () => {
    assert.match(tableBlock('meeting_discussion_appearances'),
      /carried_from_id uuid REFERENCES public\.meeting_discussion_appearances\(id\)/)
    assert.match(fnBody('apply_meeting_discussion_carry_forward'), /r\.source_appearance_id/)
  })

  test('completing a meeting is untouched — set_meeting_status is not re-emitted', () => {
    assert.ok(!/FUNCTION public\.set_meeting_status/.test(code),
      'meeting completion must keep behaving exactly as it did')
  })
})

// ─── 7. Nothing shipped was changed ──────────────────────────────────────────

describe('the Order rail and its evidence are left as they are', () => {
  test('add_meeting_order_evidence is not re-emitted', () => {
    assert.ok(!/FUNCTION public\.add_meeting_order_evidence/.test(
      code.replace(/pg_get_function[\s\S]*?;/g, '')),
      'the shipped three-argument RPC must keep its exact signature')
  })

  test('the migration asserts that signature is still intact at apply time', () => {
    // The parameter NAMES are part of what pg_get_function_identity_arguments
    // returns on this stack, and they are part of the contract: PostgREST calls
    // this RPC by named arguments, so a rename would break the browser exactly as
    // a retype would. Confirmed against the live catalogue during the rehearsal.
    assert.match(
      code,
      /pg_get_function_identity_arguments\(p\.oid\) = 'p_order_id uuid, p_storage_path text, p_file_name text'/,
    )
  })

  test('discussion evidence is its own function, on the same bucket and path shape', () => {
    const body = fnBody('add_meeting_discussion_evidence')
    assert.match(body, /bucket_id = 'meeting-evidence'/)
    // The folder is still the meeting_order id, so all three shipped storage
    // policies apply unchanged and no new bucket or policy is needed.
    assert.match(body, /ensure_meeting_discussion_order\(p_appearance_id\)/)
    assert.match(body, /v_order_id::text \|\| '\/\[0-9a-f\]\{8\}/)
  })

  test('type and size still come from Storage, never from the caller', () => {
    const body = fnBody('add_meeting_discussion_evidence')
    assert.match(body, /o\.metadata ->> 'mimetype'/)
    assert.match(body, /o\.metadata ->> 'size'/)
    const signature = body.slice(0, body.indexOf('RETURNS'))
    assert.ok(!/p_mime|p_size|p_type|p_uploaded_by|p_meeting_id/.test(signature))
  })

  test('an image is recorded only if the object exists and the caller uploaded it', () => {
    const body = fnBody('add_meeting_discussion_evidence')
    assert.match(body, /o\.owner_id = v_uid::text OR o\.owner = v_uid/)
    assert.match(body, /MEETING_EVIDENCE_NOT_STORED/)
    const check = body.indexOf('MEETING_EVIDENCE_NOT_STORED')
    const insert = body.indexOf('INSERT INTO public.meeting_order_evidence')
    assert.ok(check > -1 && insert > check)
  })

  test('the order rail row is created lazily, so a new draft stays deletable', () => {
    // meetings_prevent_delete_with_content refuses a meeting that has ANY order
    // row. Creating one per inherited issue at carry-forward time would make every
    // new draft undeletable — a shipped behaviour this must not change.
    const carry = fnBody('apply_meeting_discussion_carry_forward')
    assert.ok(!/meeting_orders/.test(carry))
    assert.match(fnBody('ensure_meeting_discussion_order'), /INSERT INTO public\.meeting_orders/)
  })

  test('adopting an existing order row never duplicates one', () => {
    assert.match(fnBody('ensure_meeting_discussion_order'),
      /ON CONFLICT ON CONSTRAINT meeting_orders_unique_per_meeting DO NOTHING/)
  })

  test('an appearance can only point at an order row in its own meeting', () => {
    assert.match(code, /CREATE TRIGGER meeting_discussion_appearance_order_in_meeting_trg/)
    assert.match(fnBody('meeting_discussion_appearance_order_in_meeting'),
      /o\.id = NEW\.meeting_order_id AND o\.meeting_id = NEW\.meeting_id/)
    assert.match(code, /MEETING_DISCUSSION_ORDER_MISMATCH/)
  })
})

// ─── 8. Indexes the reads need ───────────────────────────────────────────────

describe('the queries the workflow actually runs are indexed', () => {
  const expected = [
    // carry-forward's predicate and the board's category filter
    'meeting_discussion_items_open_by_category_idx',
    // "what else was raised against this order?"
    'meeting_discussion_items_order_key_idx',
    // the source-task lookup capture does
    'meeting_discussion_items_source_task_idx',
    // the board: this meeting's agenda in order
    'meeting_discussion_appearances_meeting_idx',
    // the thread: every meeting one issue has been on
    'meeting_discussion_appearances_item_idx',
    // one issue's trail, newest first
    'meeting_discussion_events_item_idx',
    // per-meeting grouping and the linked-task list
    'meeting_discussion_events_appearance_idx',
    // evidence tagged to one issue
    'meeting_order_evidence_discussion_idx',
  ]
  for (const index of expected) {
    test(`${index} exists`, () => {
      assert.match(code, new RegExp(`CREATE (UNIQUE )?INDEX IF NOT EXISTS ${index}\\b`))
    })
  }
})

// ─── 9. Guard messages reach the reader ──────────────────────────────────────

describe('every guard this migration raises has a reader-facing message', () => {
  test('and errors.ts knows all of them', () => {
    // A prefix the classifier does not know shows the user a generic sentence
    // instead of the one the guard wrote — which is the whole point of the prefix.
    const raised = [...code.matchAll(/'(MEETING_[A-Z_]+):/g)].map(m => m[1])
    assert.ok(raised.length > 0)
    const errors = readFileSync(join(process.cwd(), 'src', 'lib', 'meetings', 'errors.ts'), 'utf8')
    for (const prefix of [...new Set(raised)]) {
      assert.match(errors, new RegExp(`'${prefix}:'`), `${prefix} is not in GUARD_PREFIXES`)
    }
  })

  test('no guard message names a table, a policy or a function', () => {
    const messages = [...code.matchAll(/'MEETING_[A-Z_]+: ([^']*)'/g)].map(m => m[1])
    assert.ok(messages.length > 0)
    for (const message of messages) {
      for (const jargon of ['meeting_discussion', 'RLS', 'policy', 'RPC', 'constraint', 'null']) {
        assert.ok(!message.toLowerCase().includes(jargon.toLowerCase()),
          `"${message}" leaks the word "${jargon}"`)
      }
    }
  })
})

// ─── 10. The migration checks itself at apply time ───────────────────────────

describe('the migration asserts its own guarantees when it runs', () => {
  test('there is an assertion block, and it is the last thing in the file', () => {
    const assertions = [...code.matchAll(/DO \$\$/g)]
    assert.ok(assertions.length >= 1)
    assert.ok(code.trimEnd().endsWith('END $$;'))
  })

  test('it checks RLS, the write policies, the privileges and the gates per table', () => {
    for (const needle of [
      'must have RLS enabled',
      'has a permissive write policy',
      'is missing its RESTRICTIVE module entry gate',
      'still holds a write privilege on',
    ]) {
      assert.ok(code.includes(needle), `the assertion block does not check: ${needle}`)
    }
  })

  test('it checks both duplicate-prevention rules', () => {
    assert.ok(code.includes('one item can appear twice in one meeting'))
    assert.ok(code.includes('one task could raise two open issues'))
  })

  test('it checks that carry-forward is wired to creation', () => {
    assert.ok(code.includes('carry-forward is not attached to meeting creation'))
  })

  test('it checks that no client role can reach the internal writers', () => {
    assert.ok(code.includes('a client role can execute'))
  })
})

// ─── Review fixes (PR #164) ──────────────────────────────────────────────────

describe('meeting notes follow the meeting', () => {
  test('every trail row is gated per row, and a meeting row on that meeting', () => {
    assert.match(code, /CREATE POLICY "meeting_discussion_events_select"[\s\S]*?USING \(public\.can_view_discussion_event\(discussion_item_id, meeting_id, event_type, created_at, auth\.uid\(\)\)\)/)
    const body = fnBody('can_view_discussion_event')
    assert.match(body, /WHEN p_meeting_id IS NOT NULL THEN\s+public\.can_view_meeting\(p_meeting_id, p_user_id\)/)
    assert.match(body, /WHEN p_event_type = 'captured' THEN\s+public\.can_view_discussion_item\(p_item_id, p_user_id\)/)
    // A reopening reason follows the meeting whose resolution it reopens.
    assert.match(body, /WHEN p_event_type = 'reopened' THEN[\s\S]*?can_view_meeting\(r\.meeting_id, p_user_id\)[\s\S]*?r\.event_type = 'resolved'/)
    // Anything else with no meeting (a deleted draft's detached rows): nobody.
    assert.match(body, /ELSE false\s+END/)
  })

  test('resolution_note is not granted to any client role', () => {
    const grant = code.match(/GRANT SELECT \(([\s\S]*?)\) ON public\.meeting_discussion_items TO authenticated/)
    assert.ok(grant, 'the issue row is granted column by column')
    assert.ok(!grant![1].includes('resolution_note'))
    assert.match(code, /has_column_privilege\('authenticated', 'public\.meeting_discussion_items', 'resolution_note', 'SELECT'\)/)
  })

  test("a meetings 'edit' or 'manage' grant reveals only Inbox issues", () => {
    const body = fnBody('can_view_discussion_item')
    assert.match(body, /NOT EXISTS \([\s\S]*?\)\s+AND \([\s\S]*?resolve_permission\(p_user_id, 'meetings', 'edit'\)[\s\S]*?resolve_permission\(p_user_id, 'meetings', 'manage'\)/)
  })
})

describe('a draft holding a discussion cannot be deleted', () => {
  const body = fnBody('meetings_prevent_delete_with_discussion')

  test('every kind of substantive activity refuses', () => {
    for (const needle of [
      "a.placement <> 'automatic'",
      'a.latest_update    IS NOT NULL',
      'a.decision         IS NOT NULL',
      'a.next_review_date IS NOT NULL',
      'a.discussed_at     IS NOT NULL',
      'a.meeting_order_id IS NOT NULL',
      'ev.discussion_appearance_id = a.id',
      "e.event_type IN ('update', 'task_linked', 'resolved', 'reopened')",
    ]) {
      assert.ok(body.includes(needle), `the guard does not check ${needle}`)
    }
    assert.match(body, /RAISE EXCEPTION 'MEETING_HAS_DISCUSSION:/)
  })

  test('it is a BEFORE DELETE trigger, and carry-forward marks what it adds as automatic', () => {
    assert.match(code, /CREATE TRIGGER meetings_prevent_delete_with_discussion_trg\s+BEFORE DELETE ON public\.meetings/)
    assert.match(fnBody('apply_meeting_discussion_carry_forward'), /'automatic', p_actor_id/)
    assert.match(code, /placement text NOT NULL DEFAULT 'manual' CHECK \(placement IN \('manual', 'automatic'\)\)/)
  })
})

describe('the Meeting Inbox is read by the database', () => {
  test('no appearance ANYWHERE, filtered to what this reader may see, behind module entry', () => {
    const body = fnBody('list_meeting_discussion_inbox')
    assert.match(body, /IF NOT public\.module_entry_open\('meetings'\) THEN/)
    assert.match(body, /NOT EXISTS \(\s*SELECT 1 FROM public\.meeting_discussion_appearances a\s+WHERE a\.discussion_item_id = i\.id\s*\)/)
    assert.match(body, /public\.can_view_discussion_item\(i\.id, v_uid\)/)
    assert.ok(!body.includes('resolution_note'), 'the Inbox read returns no meeting note')
  })
})

describe('clearing a decision is explicit', () => {
  test('a NULL decision leaves it alone; only p_clear_decision removes it', () => {
    const body = fnBody('save_meeting_discussion_update')
    assert.match(body, /p_clear_decision\s+boolean DEFAULT false/)
    assert.match(body, /decision\s+= CASE\s+WHEN p_clear_decision THEN NULL\s+ELSE COALESCE\(v_decision, decision\)/)
    assert.match(body, /'Decision cleared'/)
  })
})
