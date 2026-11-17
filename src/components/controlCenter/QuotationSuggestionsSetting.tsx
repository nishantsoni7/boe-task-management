'use client'

import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { CcBadge, CcSection, cc } from './CcPrimitives'
import { errorText, fetchSuggestionSettings, saveSuggestionSettings } from '@/lib/quotations/api'

// Control Center › Sales › Quotation price approval: who sees the SUGGESTED prices on a quotation (owner, 18 Nov 2026:
// the training data is still thin, so the suggestions are vague; keep them for the owner to verify, and give them to
// everyone once they are accurate). "Only me" keeps them for the administrator who switches it; everyone else sees only
// the price history (last ordered / quoted). quotation_suggestions_set refuses anyone but an administrator.

const KEY = ['quotations', 'suggestions'] as const

export function QuotationSuggestionsSetting() {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: KEY, queryFn: () => fetchSuggestionSettings(supabase), retry: false })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const v = query.data
  if (query.isError) return <div className={cc.error} role="alert">Who sees price suggestions could not be read: {errorText(query.error)}</div>
  if (!v) return <div className={cc.muted} style={{ fontSize: 12.5 }}>Loading…</div>

  const save = async (everyone: boolean) => {
    setError('')
    setSaved('')
    setSaving(true)
    try {
      await saveSuggestionSettings(supabase, everyone)
      setSaved(everyone ? 'Everyone sees the price suggestions again.' : 'Only you see the price suggestions now.')
      await queryClient.invalidateQueries({ queryKey: ['quotations'] })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <CcSection
      title="Price suggestions on quotations"
      description="Who sees the suggested price under each product. Everyone else still sees the price history (last ordered and last quoted)."
    >
      <div className={cc.list}>
        <div className={cc.listRow}>
          <div className={cc.listMain}>
            <div>Suggested prices</div>
            <div className={cc.listDetail}>
              {v.everyone
                ? 'Shown to everyone who prices quotations.'
                : `Shown only to ${v.shown_to.length ? v.shown_to.join(', ') : 'nobody'}. Everyone else sees the history only.`}
            </div>
          </div>
          <div className={cc.rowActions}>
            <CcBadge tone={v.everyone ? 'green' : 'gray'}>{v.everyone ? 'Everyone' : 'Only selected'}</CcBadge>
            {v.everyone
              ? <button className="boe-btn boe-btn-ghost" disabled={saving || !v.may_change} onClick={() => void save(false)}>{saving ? 'Saving…' : 'Only me'}</button>
              : <button className="boe-btn boe-btn-ghost" disabled={saving || !v.may_change} onClick={() => void save(true)}>{saving ? 'Saving…' : 'Show to everyone'}</button>}
          </div>
        </div>
      </div>
      {error && <div className={cc.error} role="alert">{error}</div>}
      {saved && <div className={cc.muted} role="status" style={{ fontSize: 12.5 }}>{saved}</div>}
    </CcSection>
  )
}
