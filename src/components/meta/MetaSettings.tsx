'use client'

import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { amountInputProblem, isValidAmount, sanitizeAmountInput } from '@/lib/currency'
import { metaWriteMessage, saveMetaTargets } from '@/lib/meta/api'
import { createClient } from '@/lib/supabase/client'
import { ConnectionPanel } from './metaParts'
import { MetaScreen, type MetaCtx } from './MetaScreen'
import s from './meta.module.css'

const toRupees = (paise: number | null) => (paise === null ? '' : String(paise / 100))

/** Empty is "not set" (null); a number is paise; anything else is undefined, which the form refuses. */
function toPaise(raw: string): number | null | undefined {
  const v = sanitizeAmountInput(raw)
  if (v === '') return null
  return isValidAmount(v) ? Math.round(Number(v) * 100) : undefined
}

function Field({ id, label, help, value, onChange, disabled }: {
  id: string; label: string; help: string; value: string; onChange: (v: string) => void; disabled: boolean
}) {
  const problem = amountInputProblem(sanitizeAmountInput(value))
  return (
    <div className={s.field}>
      <label className="boe-input-label" htmlFor={id}>{label}</label>
      <div className={s.fieldInput}>
        <span aria-hidden="true">₹</span>
        <input
          id={id} className="boe-input" inputMode="decimal" autoComplete="off" value={value} disabled={disabled}
          aria-invalid={problem ? true : undefined} aria-describedby={`${id}-help`}
          onChange={e => onChange(e.target.value)}
        />
      </div>
      <div id={`${id}-help`} className={problem ? 'boe-field-error' : 'boe-field-help'}>{problem ?? help}</div>
    </div>
  )
}

function Numbers({ ctx }: { ctx: MetaCtx }) {
  const { settings } = ctx.structure
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const [cap, setCap] = useState(toRupees(settings.monthly_cap_paise))
  const [target, setTarget] = useState(toRupees(settings.target_cost_per_enquiry_paise))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)

  const capPaise = toPaise(cap)
  const targetPaise = toPaise(target)
  const valid = capPaise !== undefined && targetPaise !== undefined
  const changed = valid && (capPaise !== settings.monthly_cap_paise || targetPaise !== settings.target_cost_per_enquiry_paise)

  const save = async () => {
    if (!valid || busy) return
    setBusy(true)
    setMessage(null)
    try {
      await saveMetaTargets(supabase, capPaise, targetPaise)
      await queryClient.invalidateQueries({ queryKey: ['meta'] })
      setMessage({ text: 'Saved.', ok: true })
    } catch (error) {
      setMessage({ text: metaWriteMessage(error), ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={`boe-panel ${s.panel}`} aria-labelledby="meta-numbers">
      <h2 className={s.heading} id="meta-numbers">Your numbers</h2>
      {!ctx.canEdit && <p className={s.note}>You can see these but not change them. Ask an administrator for Marketing edit access.</p>}
      <div className={s.form}>
        <Field
          id="meta-cap" label="Monthly spending cap" disabled={!ctx.canEdit || busy} value={cap} onChange={setCap}
          help="The most you want to spend on ads in a month. The Overview shows spend against it. Leave empty for none."
        />
        <Field
          id="meta-target" label="Target cost per chat" disabled={!ctx.canEdit || busy} value={target} onChange={setTarget}
          help="What you are happy to pay for one chat. Ad sets are judged against it. Leave empty for none."
        />
        {ctx.canEdit && (
          <div className={s.actions}>
            <button type="button" className="boe-btn boe-btn-primary" disabled={!changed || busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</button>
            {message && <span role={message.ok ? 'status' : 'alert'} className={message.ok ? s.note : 'boe-field-error'}>{message.text}</span>}
          </div>
        )}
      </div>
    </section>
  )
}

export function MetaSettings() {
  return (
    <MetaScreen title="Settings" subtitle="The two numbers the Overview judges against, and what is connected." gated={false} withRange={false}>
      {ctx => (
        <div className={s.columns}>
          <Numbers ctx={ctx} />
          <ConnectionPanel ctx={ctx} />
        </div>
      )}
    </MetaScreen>
  )
}
