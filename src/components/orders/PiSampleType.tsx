'use client'

import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FlaskConical } from 'lucide-react'
import {
  PI_SAMPLE_TYPE_RPC,
  SAMPLE_FIELD_HINT,
  SAMPLE_FIELD_LABEL,
  SAMPLE_NONE_LABEL,
  SAMPLE_TYPES,
  SAMPLE_TYPE_LABEL,
  SAMPLE_TYPE_OPTION_LABEL,
  describeSampleTypeFailure,
  readSampleType,
  type SampleType,
} from '@/lib/orders/sampleType'

/**
 * THE SAMPLE CHOICE (20270320000000) — one control for the PI draft and the
 * Confirmed Order: Not a sample / Sampling needed before production / Sample
 * order only. Saved the moment it is changed. Presentation only: `canEdit` is
 * the page's answer and the RPC re-derives it. A reader who may not edit sees
 * the choice as words.
 */
export function SampleTypeControl({ value, canEdit, saving, failure, onChange, id }: {
  value: SampleType | null
  canEdit: boolean
  saving: boolean
  failure: string | null
  onChange: (next: SampleType | null) => void
  id: string
}) {
  return (
    <div className="pi-sample-type">
      <label htmlFor={canEdit ? id : undefined} className="pi-sample-type-label">
        <FlaskConical size={13} strokeWidth={2} aria-hidden="true" />
        {SAMPLE_FIELD_LABEL}
      </label>
      {canEdit ? (
        <select
          id={id}
          className="pi-form-input pi-sample-type-select"
          value={value ?? ''}
          disabled={saving}
          aria-describedby={`${id}-hint`}
          onChange={e => onChange(readSampleType(e.target.value))}
        >
          <option value="">{SAMPLE_NONE_LABEL}</option>
          {SAMPLE_TYPES.map(t => <option key={t} value={t}>{SAMPLE_TYPE_OPTION_LABEL[t]}</option>)}
        </select>
      ) : (
        <p className="pi-sample-type-value">{value ? SAMPLE_TYPE_LABEL[value] : SAMPLE_NONE_LABEL}</p>
      )}
      <span id={`${id}-hint`} className="pi-sample-type-hint">{saving ? 'Saving…' : SAMPLE_FIELD_HINT}</span>
      {failure && <div role="alert" className="pi-detail-highlight-error">{failure}</div>}
    </div>
  )
}

type Read = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; value: SampleType | null }

/**
 * The PI draft's sample choice: reads its own column and saves through its own
 * RPC, so the page's main read never depends on this migration. `rowVersion`
 * is the PI's row_version (optimistic concurrency); `onSaved` lets the page
 * re-read so the next write elsewhere carries the new version.
 */
export function PiSampleType({ supabase, submissionId, canEdit, rowVersion, onSaved }: {
  supabase: SupabaseClient
  submissionId: string
  canEdit: boolean
  rowVersion: number | null
  onSaved: () => void
}) {
  const [read, setRead] = useState<Read>({ kind: 'loading' })
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('order_submissions')
          .select('sample_type')
          .eq('id', submissionId)
          .maybeSingle()
        if (!live) return
        setRead(error || !data ? { kind: 'unavailable' } : { kind: 'ready', value: readSampleType((data as { sample_type?: unknown }).sample_type) })
      } catch {
        if (live) setRead({ kind: 'unavailable' })
      }
    })()
    return () => { live = false }
  }, [supabase, submissionId, rowVersion])

  // A database without the column yet: nothing is drawn.
  if (read.kind !== 'ready') return null

  const change = async (next: SampleType | null) => {
    if (saving) return
    setSaving(true)
    setFailure(null)
    const before = read.value
    setRead({ kind: 'ready', value: next })
    try {
      const { error } = await supabase.rpc(PI_SAMPLE_TYPE_RPC, {
        p_submission_id: submissionId,
        p_sample_type: next,
        p_expected_version: rowVersion,
      })
      if (error) {
        setRead({ kind: 'ready', value: before })
        setFailure(describeSampleTypeFailure(error))
      } else {
        onSaved()
      }
    } catch {
      setRead({ kind: 'ready', value: before })
      setFailure('That did not save. Check your connection and try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <SampleTypeControl
      id="pi-sample-type"
      value={read.value}
      canEdit={canEdit}
      saving={saving}
      failure={failure}
      onChange={next => { void change(next) }}
    />
  )
}
