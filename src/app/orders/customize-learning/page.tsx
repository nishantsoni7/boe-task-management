'use client'

// /orders/customize-learning — where an admin teaches Customize image.
//
// Three tabs:
//   Attempts     what salespeople asked, what was understood, the picture made,
//                and their 👍/👎. "Teach from this" turns one into an approved
//                example (with the corrected instruction); "Dismiss" marks it seen.
//   House rules  plain-English rules given to EVERY Check understanding.
//   Examples     approved examples; the most similar ones are given to Check
//                understanding for each new request.
//
// Nothing is learned without an admin approving it, and every rule and example
// can be switched off. The page hides itself from people who may not train,
// but the authority is the database's: every route asks
// can_train_customize_image() (20270420000000).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { OrdersLayout } from '@/components/layout/OrdersLayout'
import { usePermissionContext } from '@/hooks/queries/usePermissionContext'
import { MAX_INSTRUCTION_LENGTH } from '@/lib/orders/customizationImage'
import { RULE_MAX, keywordsFrom } from '@/lib/orders/customizationLearning'

type Tab = 'attempts' | 'rules' | 'examples'
type Filter = 'unreviewed' | 'wrong' | 'all'

type Attempt = {
  id: string
  created_at: string
  created_by_name: string | null
  comment: string
  product_name: string | null
  pi_dimensions: string | null
  understood_instruction: string
  understood_assumptions: string[]
  final_instruction: string | null
  instruction_edited: boolean
  outcome: string
  feedback: 'correct' | 'wrong' | null
  feedback_note: string | null
  reviewed_at: string | null
  applied_rule_ids: string[]
  applied_example_ids: string[]
  source_url: string | null
  result_url: string | null
}
type Rule = { id: string; rule_text: string; is_active: boolean; source: string; created_at: string }
type Example = {
  id: string
  comment: string
  instruction: string
  product_name: string | null
  pi_dimensions: string | null
  keywords: string[]
  is_active: boolean
  created_at: string
  before_url: string | null
  after_url: string | null
}

const OUTCOME_LABEL: Record<string, string> = {
  understood: 'Checked only', generated: 'Picture made', used: 'Used on the PI',
  discarded: 'Discarded', refined: 'Changed further', failed: 'Picture failed',
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: true; body: T } | { ok: false; message: string; code?: string }> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, message: body.message ?? 'Something went wrong. Please try again.', code: body.error }
    return { ok: true, body: body as T }
  } catch {
    return { ok: false, message: 'Check your connection and try again.' }
  }
}

function Picture({ url, label }: { url: string | null; label: string }) {
  return (
    <figure className="cil-pic">
      <div className="pi-edit-photo-frame">
        {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed URL from a private bucket */}
        {url ? <img src={url} alt={label} /> : <span>No picture</span>}
      </div>
      <figcaption>{label}</figcaption>
    </figure>
  )
}

function TeachForm({ attempt, onDone, onCancel }: { attempt: Attempt; onDone: () => void; onCancel: () => void }) {
  const [instruction, setInstruction] = useState(attempt.final_instruction ?? attempt.understood_instruction)
  const [keywords, setKeywords] = useState(keywordsFrom(attempt.comment, attempt.product_name ?? '').join(', '))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setSaving(true); setError(null)
    const r = await call('/api/orders/customize-learning/examples', {
      method: 'POST',
      body: JSON.stringify({ attemptId: attempt.id, comment: attempt.comment, instruction, keywords }),
    })
    setSaving(false)
    if (!r.ok) { setError(r.message); return }
    onDone()
  }
  return (
    <div className="cil-teach">
      <p className="pi-regen-note">Write the instruction as it SHOULD have been understood. Future requests with similar words will be read this way.</p>
      <label className="pi-edit-field"><span>Correct instruction</span>
        <textarea rows={5} className="boe-input" value={instruction} maxLength={MAX_INSTRUCTION_LENGTH} onChange={e => setInstruction(e.target.value)} /></label>
      <label className="pi-edit-field"><span>Words that make a request similar (comma separated)</span>
        <input className="boe-input" value={keywords} onChange={e => setKeywords(e.target.value)} /></label>
      {error && <p role="alert" className="pi-regen-error">{error}</p>}
      <div className="pi-regen-actions">
        <button type="button" className="boe-btn boe-btn-primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Approve as example'}</button>
        <button type="button" className="boe-btn boe-btn-ghost" disabled={saving} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function AttemptsTab() {
  const [filter, setFilter] = useState<Filter>('unreviewed')
  const [rows, setRows] = useState<Attempt[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [teaching, setTeaching] = useState<string | null>(null)

  const fetchPage = useCallback((before?: string) => {
    const qs = new URLSearchParams({ filter, ...(before ? { before } : {}) })
    return call<{ attempts: Attempt[]; more: boolean }>(`/api/orders/customize-learning/attempts?${qs}`)
  }, [filter])
  const show = (r: Awaited<ReturnType<typeof fetchPage>>, append: boolean) => {
    setLoading(false)
    if (!r.ok) { setError(r.message); return }
    setError(null)
    setRows(prev => (append ? [...prev, ...r.body.attempts] : r.body.attempts))
    setMore(r.body.more)
  }
  useEffect(() => {
    let live = true
    void fetchPage().then(r => {
      if (!live) return
      setLoading(false)
      if (!r.ok) { setError(r.message); return }
      setError(null); setRows(r.body.attempts); setMore(r.body.more)
    })
    return () => { live = false }
  }, [fetchPage])
  const changeFilter = (next: Filter) => {
    if (next === filter) return
    setLoading(true); setRows([]); setMore(false); setFilter(next)
  }
  const showOlder = async () => {
    setLoading(true)
    show(await fetchPage(rows[rows.length - 1]?.created_at), true)
  }

  const review = async (id: string, action: 'dismiss' | 'reopen') => {
    const r = await call('/api/orders/customize-learning/attempts', { method: 'PATCH', body: JSON.stringify({ id, action }) })
    if (!r.ok) { setError(r.message); return }
    if (filter === 'unreviewed') setRows(rs => rs.filter(a => a.id !== id))
    else setRows(rs => rs.map(a => (a.id === id ? { ...a, reviewed_at: action === 'dismiss' ? new Date().toISOString() : null } : a)))
  }

  return (
    <section>
      <div className="cil-filters" role="group" aria-label="Show">
        {([['unreviewed', 'Not reviewed'], ['wrong', '👎 Marked wrong'], ['all', 'All']] as const).map(([k, label]) => (
          <button key={k} type="button" className={filter === k ? 'pi-regen-chip cil-chip-on' : 'pi-regen-chip'} onClick={() => changeFilter(k)}>{label}</button>
        ))}
      </div>
      {error && <p role="alert" className="pi-regen-error">{error}</p>}
      {!loading && rows.length === 0 && !error && <p className="pi-regen-note">Nothing here yet.</p>}
      <ul className="cil-list">
        {rows.map(a => (
          <li key={a.id} className="cil-card">
            <div className="cil-card-head">
              <strong>{a.product_name || 'Product'}</strong>
              <span>{a.created_by_name ?? 'Former member'} · {when(a.created_at)} · {OUTCOME_LABEL[a.outcome] ?? a.outcome}</span>
              {a.feedback === 'correct' && <span className="cil-badge cil-badge-ok">👍 Correct</span>}
              {a.feedback === 'wrong' && <span className="cil-badge cil-badge-bad">👎 Wrong</span>}
              {a.reviewed_at && <span className="cil-badge">Reviewed</span>}
            </div>
            <div className="cil-card-body">
              <Picture url={a.source_url} label="Before" />
              <Picture url={a.result_url} label="After" />
              <div className="cil-text">
                <p><span>Salesperson wrote</span>{a.comment}</p>
                {a.pi_dimensions && <p><span>PI size</span>{a.pi_dimensions}</p>}
                <p><span>Understood as</span>{a.understood_instruction}</p>
                {a.instruction_edited && a.final_instruction && <p><span>Salesperson changed it to</span>{a.final_instruction}</p>}
                {a.feedback_note && <p><span>What was wrong</span>{a.feedback_note}</p>}
                <p className="pi-regen-note">Used {a.applied_rule_ids.length} rule{a.applied_rule_ids.length === 1 ? '' : 's'} and {a.applied_example_ids.length} example{a.applied_example_ids.length === 1 ? '' : 's'}.</p>
              </div>
            </div>
            {teaching === a.id
              ? <TeachForm attempt={a} onCancel={() => setTeaching(null)} onDone={() => {
                  setTeaching(null)
                  if (filter === 'unreviewed') setRows(rs => rs.filter(x => x.id !== a.id))
                  else setRows(rs => rs.map(x => (x.id === a.id ? { ...x, reviewed_at: new Date().toISOString() } : x)))
                }} />
              : (
                <div className="pi-regen-actions">
                  <button type="button" className="boe-btn boe-btn-primary" onClick={() => setTeaching(a.id)}>Teach from this</button>
                  {a.reviewed_at
                    ? <button type="button" className="boe-btn boe-btn-ghost" onClick={() => void review(a.id, 'reopen')}>Mark not reviewed</button>
                    : <button type="button" className="boe-btn boe-btn-ghost" onClick={() => void review(a.id, 'dismiss')}>Dismiss</button>}
                </div>
              )}
          </li>
        ))}
      </ul>
      {loading && <p className="pi-regen-note">Loading…</p>}
      {more && !loading && (
        <button type="button" className="boe-btn boe-btn-ghost" onClick={() => void showOlder()}>Show older</button>
      )}
    </section>
  )
}

function RulesTab() {
  const [rules, setRules] = useState<Rule[]>([])
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = (r: Awaited<ReturnType<typeof call<{ rules: Rule[] }>>>) => {
    if (!r.ok) { setError(r.message); return }
    setRules(r.body.rules)
  }
  const load = async () => apply(await call<{ rules: Rule[] }>('/api/orders/customize-learning/rules'))
  useEffect(() => {
    let live = true
    void call<{ rules: Rule[] }>('/api/orders/customize-learning/rules').then(r => { if (live) apply(r) })
    return () => { live = false }
  }, [])

  const send = async (method: 'POST' | 'PATCH', payload: Record<string, unknown>) => {
    setBusy(true); setError(null)
    const r = await call<{ rule: Rule }>('/api/orders/customize-learning/rules', { method, body: JSON.stringify(payload) })
    setBusy(false)
    if (!r.ok) { setError(r.message); return false }
    await load()
    return true
  }

  return (
    <section>
      <p className="pi-regen-note">Every switched-on rule is given to every “Check understanding”. Write them the way you would explain it to a new salesperson.</p>
      <div className="cil-add">
        <textarea rows={2} className="boe-input" value={draft} maxLength={RULE_MAX}
          placeholder="e.g. A dining table longer than 2.4 m on legs gets a centre leg as well."
          onChange={e => setDraft(e.target.value)} />
        <button type="button" className="boe-btn boe-btn-primary" disabled={busy || draft.trim() === ''}
          onClick={async () => { if (await send('POST', { rule_text: draft })) setDraft('') }}>Add rule</button>
      </div>
      {error && <p role="alert" className="pi-regen-error">{error}</p>}
      <ol className="cil-list">
        {rules.map(rule => (
          <li key={rule.id} className={rule.is_active ? 'cil-card' : 'cil-card cil-off'}>
            {editing?.id === rule.id
              ? (
                <div className="cil-add">
                  <textarea rows={3} className="boe-input" value={editing.text} maxLength={RULE_MAX} onChange={e => setEditing({ id: rule.id, text: e.target.value })} />
                  <div className="pi-regen-actions">
                    <button type="button" className="boe-btn boe-btn-primary" disabled={busy}
                      onClick={async () => { if (await send('PATCH', { id: rule.id, rule_text: editing.text })) setEditing(null) }}>Save</button>
                    <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              )
              : <p className="cil-rule">{rule.rule_text}</p>}
            <div className="cil-card-head">
              <span>{rule.source === 'seed' ? 'Starter rule' : rule.source === 'suggested' ? 'Suggested' : 'Added by admin'} · {rule.is_active ? 'On' : 'Off'}</span>
              <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => void send('PATCH', { id: rule.id, is_active: !rule.is_active })}>
                {rule.is_active ? 'Switch off' : 'Switch on'}
              </button>
              {editing?.id !== rule.id && <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setEditing({ id: rule.id, text: rule.rule_text })}>Edit</button>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function ExamplesTab() {
  const [examples, setExamples] = useState<Example[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; instruction: string; keywords: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const apply = (r: Awaited<ReturnType<typeof call<{ examples: Example[] }>>>) => {
    if (!r.ok) { setError(r.message); return }
    setExamples(r.body.examples)
  }
  const load = async () => apply(await call<{ examples: Example[] }>('/api/orders/customize-learning/examples'))
  useEffect(() => {
    let live = true
    void call<{ examples: Example[] }>('/api/orders/customize-learning/examples').then(r => { if (live) apply(r) })
    return () => { live = false }
  }, [])

  const patch = async (payload: Record<string, unknown>) => {
    setBusy(true); setError(null)
    const r = await call('/api/orders/customize-learning/examples', { method: 'PATCH', body: JSON.stringify(payload) })
    setBusy(false)
    if (!r.ok) { setError(r.message); return false }
    await load()
    return true
  }

  return (
    <section>
      <p className="pi-regen-note">For each new request, the switched-on examples that share the most words with it are given to “Check understanding”. Approve examples from the Attempts tab.</p>
      {error && <p role="alert" className="pi-regen-error">{error}</p>}
      {examples.length === 0 && !error && <p className="pi-regen-note">No approved examples yet.</p>}
      <ul className="cil-list">
        {examples.map(ex => (
          <li key={ex.id} className={ex.is_active ? 'cil-card' : 'cil-card cil-off'}>
            <div className="cil-card-body">
              <Picture url={ex.before_url} label="Before" />
              <Picture url={ex.after_url} label="After" />
              <div className="cil-text">
                {ex.product_name && <p><span>Product</span>{ex.product_name}</p>}
                <p><span>Salesperson wrote</span>{ex.comment}</p>
                {editing?.id === ex.id
                  ? (
                    <>
                      <label className="pi-edit-field"><span>Correct instruction</span>
                        <textarea rows={4} className="boe-input" value={editing.instruction} maxLength={MAX_INSTRUCTION_LENGTH}
                          onChange={e => setEditing({ ...editing, instruction: e.target.value })} /></label>
                      <label className="pi-edit-field"><span>Words (comma separated)</span>
                        <input className="boe-input" value={editing.keywords} onChange={e => setEditing({ ...editing, keywords: e.target.value })} /></label>
                    </>
                  )
                  : (
                    <>
                      <p><span>Correct instruction</span>{ex.instruction}</p>
                      <p><span>Words</span>{ex.keywords.join(', ')}</p>
                    </>
                  )}
              </div>
            </div>
            <div className="pi-regen-actions">
              {editing?.id === ex.id
                ? (
                  <>
                    <button type="button" className="boe-btn boe-btn-primary" disabled={busy}
                      onClick={async () => { if (await patch({ id: ex.id, instruction: editing.instruction, keywords: editing.keywords })) setEditing(null) }}>Save</button>
                    <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                  </>
                )
                : <button type="button" className="boe-btn boe-btn-ghost" onClick={() => setEditing({ id: ex.id, instruction: ex.instruction, keywords: ex.keywords.join(', ') })}>Edit</button>}
              <button type="button" className="boe-btn boe-btn-ghost" disabled={busy} onClick={() => void patch({ id: ex.id, is_active: !ex.is_active })}>
                {ex.is_active ? 'Switch off' : 'Switch on'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function CustomizeLearningPage() {
  const router = useRouter()
  const supabase = useMemo(() => createClient(), [])
  const { profile } = usePermissionContext()
  const [tab, setTab] = useState<Tab>('attempts')
  const [access, setAccess] = useState<'checking' | 'yes' | 'no' | 'not_set_up'>('checking')

  // Asked of the server (which asks the database), so the page and the routes agree.
  useEffect(() => {
    void call('/api/orders/customize-learning/rules').then(r => {
      if (r.ok) setAccess('yes')
      else setAccess(r.code === 'LEARNING_NOT_SET_UP' ? 'not_set_up' : 'no')
    })
  }, [])

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.replace('/login')
  }

  return (
    <OrdersLayout profile={profile} title="Customize image learning"
      subtitle="Teach Customize image how BOE reads customizations" onSignOut={handleSignOut} showRefresh={false}>
      {access === 'checking' && <p className="pi-regen-note">Loading…</p>}
      {access === 'no' && <p className="pi-regen-note">Only an administrator, or someone given “Train Customize image” in Control Center, can open this page.</p>}
      {access === 'not_set_up' && <p className="pi-regen-note">Learning is not set up on this database yet. The owner needs to apply migration 20270420000000. Customize image keeps working without it.</p>}
      {access === 'yes' && (
        <div className="cil">
          <div className="cil-tabs" role="tablist">
            {([['attempts', 'Attempts'], ['rules', 'House rules'], ['examples', 'Examples']] as const).map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'cil-tab cil-tab-on' : 'cil-tab'} onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>
          {tab === 'attempts' && <AttemptsTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'examples' && <ExamplesTab />}
        </div>
      )}
    </OrdersLayout>
  )
}
