'use client'

// CONTROL CENTER → ORDER VISIBILITY. The owner chooses, per sales candidate,
// whose orders they may see: their own, their own plus selected candidates', or
// every sales candidate's.
//
// THE SCREEN GRANTS NOTHING. list_order_visibility_scopes() and
// set_order_visibility_scope() are owner-only in the database, and the scope
// they write is applied by the database to the Orders table itself — so a
// choice made here binds the dashboard, the lists and a direct API read alike.
// A person who is not the owner gets an explanatory refusal, not a form.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { CcSection, cc } from '@/components/controlCenter/CcPrimitives'
import {
  SCOPE_CANDIDATES_NOTE,
  SCOPE_MODE_LABEL,
  SCOPE_MODES,
  SCOPE_SECTION_DESCRIPTION,
  SCOPE_SECTION_TITLE,
  describeScopeFailure,
  parseScopes,
  scopeChanged,
  validateScopeChoice,
  type ScopeMode,
  type ScopeRow,
} from '@/lib/orders/orderVisibilityScopes'

type Draft = { mode: ScopeMode; memberIds: string[] }

export function OrderVisibilityTab() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<ScopeRow[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, { ok: boolean; text: string }>>({})

  const load = useCallback(async () => {
    setLoadError('')
    const { data, error } = await supabase.rpc('list_order_visibility_scopes')
    if (error) { setRows(null); setLoadError(describeScopeFailure(error)); return }
    const parsed = parseScopes(data)
    if (!parsed.ok) { setRows(null); setLoadError(parsed.message); return }
    setRows(parsed.rows)
    setDrafts(Object.fromEntries(parsed.rows.map(r => [r.userId, { mode: r.mode, memberIds: r.memberIds }])))
  }, [supabase])

  useEffect(() => { void load() }, [load])

  const save = async (row: ScopeRow) => {
    const draft = drafts[row.userId]
    const check = validateScopeChoice(draft.mode, draft.memberIds)
    if (!check.ok) { setMessages(m => ({ ...m, [row.userId]: { ok: false, text: check.message } })); return }
    setBusy(row.userId)
    const { error } = await supabase.rpc('set_order_visibility_scope', {
      p_user_id: row.userId, p_mode: draft.mode, p_member_ids: check.members,
    })
    setBusy(null)
    if (error) { setMessages(m => ({ ...m, [row.userId]: { ok: false, text: describeScopeFailure(error) } })); return }
    setMessages(m => ({ ...m, [row.userId]: { ok: true, text: 'Saved.' } }))
    await load()
  }

  if (loadError) {
    return (
      <CcSection title={SCOPE_SECTION_TITLE}>
        <div className={cc.error} style={{ marginTop: 0, marginBottom: 12 }} role="alert">{loadError}</div>
        <button className="boe-btn boe-btn-ghost" onClick={() => void load()}>Retry</button>
      </CcSection>
    )
  }
  if (!rows) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  return (
    <CcSection title={SCOPE_SECTION_TITLE} description={SCOPE_SECTION_DESCRIPTION}>
      <p className={cc.muted} style={{ fontSize: 12.5, margin: '0 0 12px' }}>{SCOPE_CANDIDATES_NOTE}</p>
      {rows.length === 0 ? (
        <div className={cc.muted} style={{ fontSize: 12.5 }}>There are no sales candidates.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {rows.map(row => {
            const draft = drafts[row.userId] ?? { mode: row.mode, memberIds: row.memberIds }
            const others = rows.filter(r => r.userId !== row.userId)
            const msg = messages[row.userId]
            return (
              <fieldset key={row.userId} style={{ border: '1px solid rgba(0,0,0,0.1)', borderRadius: 8, padding: '10px 14px', margin: 0, minWidth: 0 }}>
                <legend style={{ fontSize: 13, fontWeight: 700, padding: '0 6px' }}>{row.fullName}</legend>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {SCOPE_MODES.map(mode => (
                    <label key={mode} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                      <input
                        type="radio" name={`scope-${row.userId}`} checked={draft.mode === mode}
                        onChange={() => { setDrafts(d => ({ ...d, [row.userId]: { ...draft, mode } })); setMessages(m => ({ ...m, [row.userId]: { ok: true, text: '' } })) }}
                      />
                      <span>{SCOPE_MODE_LABEL[mode]}</span>
                    </label>
                  ))}
                </div>
                {draft.mode === 'selected' ? (
                  <div role="group" aria-label={`Sales candidates ${row.fullName} may also see`} style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', margin: '10px 0 0 24px' }}>
                    {others.map(o => (
                      <label key={o.userId} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
                        <input
                          type="checkbox" checked={draft.memberIds.includes(o.userId)}
                          onChange={e => setDrafts(d => ({
                            ...d,
                            [row.userId]: { ...draft, memberIds: e.target.checked ? [...draft.memberIds, o.userId] : draft.memberIds.filter(id => id !== o.userId) },
                          }))}
                        />
                        {o.fullName}
                      </label>
                    ))}
                  </div>
                ) : null}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                  <button
                    type="button" className="boe-btn boe-btn-primary"
                    disabled={busy === row.userId || !scopeChanged(row, draft.mode, draft.memberIds)}
                    onClick={() => void save(row)}
                  >
                    {busy === row.userId ? 'Saving…' : 'Save'}
                  </button>
                  {msg && msg.text ? (
                    <span role={msg.ok ? 'status' : 'alert'} style={{ fontSize: 12.5, fontWeight: 600, color: msg.ok ? '#2F7A52' : '#B42318' }}>{msg.text}</span>
                  ) : null}
                </div>
              </fieldset>
            )
          })}
        </div>
      )}
    </CcSection>
  )
}
