'use client'

import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createClient } from '@/lib/supabase/client'
import { SALES_KEY } from '@/lib/salesLeads/api'
import { fetchAutoAllot, saveAutoAllot } from '@/lib/salesLeads/team'

// The same switch as Control Center > Sales team > "Give website leads automatically", one click from the Lead Master.
// Off: new website and WhatsApp leads, and the morning run, leave leads Not allotted in this register until somebody
// allots them. Admin only in the database (get_sales_auto_allot / set_sales_auto_allot), so only an Admin is shown it.
const KEY = [SALES_KEY, 'auto-allot'] as const

export function AutoAllotSwitch({ readOnly }: { readOnly: boolean }) {
  const supabase = useMemo(() => createClient(), [])
  const queryClient = useQueryClient()
  const setting = useQuery({ queryKey: KEY, queryFn: () => fetchAutoAllot(supabase), staleTime: 30_000 })
  const flip = useMutation({
    mutationFn: (on: boolean) => {
      const a = setting.data
      if (!a) throw new Error('The setting is not loaded yet.')
      return saveAutoAllot(supabase, { is_on: on, days: a.days, starts: a.starts, ends: a.ends })
    },
    onSuccess: a => queryClient.setQueryData(KEY, a),
  })

  if (!setting.data) return null
  const on = setting.data.is_on
  const title = on
    ? 'New website and WhatsApp leads are given out by the rule, in working hours. Click to switch it off: they will wait here, Not allotted.'
    : 'New website and WhatsApp leads wait here, Not allotted, until somebody allots them. Click to switch the automatic allotment on.'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button" role="switch" aria-checked={on} title={title} disabled={readOnly || flip.isPending}
        onClick={() => flip.mutate(!on)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, height: 36, padding: '0 12px 0 10px', border: '1px solid #CFC8BF', borderRadius: 8, background: '#fff', font: '500 12.5px var(--boe-font-body)', color: '#303536', cursor: readOnly ? 'not-allowed' : 'pointer', opacity: readOnly || flip.isPending ? 0.6 : 1, whiteSpace: 'nowrap' }}
      >
        <span aria-hidden="true" style={{ position: 'relative', width: 32, height: 18, borderRadius: 999, background: on ? '#2F7D4F' : '#CFC8BF', flex: '0 0 auto', transition: 'background .15s' }}>
          <span style={{ position: 'absolute', top: 2, left: on ? 16 : 2, width: 14, height: 14, borderRadius: '50%', background: '#fff', transition: 'left .15s' }} />
        </span>
        Auto-allot <b style={{ fontWeight: 600, color: on ? '#2F7D4F' : '#B42332' }}>{on ? 'on' : 'off'}</b>
      </button>
      {flip.isError && <span role="alert" style={{ fontSize: 12.5, color: '#A12438' }}>{flip.error.message}</span>}
    </span>
  )
}
