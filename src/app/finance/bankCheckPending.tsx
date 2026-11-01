'use client'

// ── Bank check pending ──────────────────────────────────────────────────────
//
// Payments an admin verified before their bank credit could be seen. They already
// count on the PI, so the only thing left is the credit. Nothing marks one as done:
// finance_bank_check_pending stops listing a payment the moment credits cover it.

import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { FinanceModal } from '@/app/finance/components/FinanceModalShell'
import { FinanceEmpty } from '@/app/finance/components/FinanceListParts'
import { formatMoney, paymentModeLabel } from '@/lib/finance/piPaymentView'
import { bankCheckState, markCandidates, type BankCheckRow, type BankMark } from '@/lib/finance/bankMarks'
import { istDateOf, istToday } from '@/lib/istDate'
import { formatBankDate } from './bank/bankStatementsModel'
import { BankMatchPanel } from './bankMarkUi'

const STATE_PILL = { ok: 'full', match: 'partial', warn: 'zero', quiet: 'neutral', stop: 'over' } as const

export function BankCheckList({ supabase, rows, marks, onChanged }: {
  supabase: SupabaseClient
  rows: BankCheckRow[]
  marks: Map<string, BankMark>
  onChanged: () => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const opened = rows.find(r => r.payment_id === openId) ?? null
  const today = istToday()

  if (rows.length === 0) {
    return <FinanceEmpty icon="check" title="Nothing is waiting for a bank check" body="A payment verified before its bank credit was seen appears here until the credit is linked." />
  }

  return (
    <div className="fin-table-wrap">
      <table className="fin-table bank-table">
        <thead><tr>
          <th style={{ width: 120 }}>Payment ID</th>
          <th className="fin-num" style={{ width: 140 }}>Amount</th>
          <th>Client</th>
          <th style={{ width: 120 }}>Paid on</th>
          <th style={{ width: 200 }}>Verified</th>
          <th style={{ width: 230 }}>Bank check</th>
          <th style={{ width: 140 }} aria-label="What to do" />
        </tr></thead>
        <tbody>
          {rows.map(r => {
            const mark = marks.get(r.payment_id)
            const state = bankCheckState(r, mark, today)
            const found = markCandidates(mark).length > 0
            return (
              <tr key={r.payment_id}>
                <td className="fin-muted">{r.human_payment_id}</td>
                <td className="fin-num"><span className="fin-amount">{formatMoney(r.amount)}</span></td>
                <td>
                  <span className="fin-primary-text">{r.client_name ?? 'Not identified'}</span>
                  <span className="fin-sub">{paymentModeLabel(r.payment_mode)}</span>
                </td>
                <td>{formatBankDate(r.payment_date)}</td>
                <td>
                  <span className="fin-primary-text">{formatBankDate(istDateOf(r.created_at))}</span>
                  <span className="fin-sub" title={r.reason}>{r.reason}</span>
                </td>
                <td><span className={`fin-pill fin-pill--${STATE_PILL[state.tone]}`}>{state.text}</span></td>
                <td>
                  <button className={`boe-btn ${found ? 'boe-btn-primary' : 'boe-btn-ghost'}`} onClick={() => setOpenId(r.payment_id)}>
                    {found ? 'Confirm match' : 'Review'}
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {opened && (
        <FinanceModal title={`${opened.human_payment_id ?? 'Payment'} · ${opened.client_name ?? 'Not identified'}`} onClose={() => setOpenId(null)} width="640px">
          <p className="fin-muted" style={{ fontSize: 12, margin: 0 }}>
            Already verified, so this counts on the PI. {formatMoney(opened.amount - opened.covered)} still needs its bank credit. Reason given: {opened.reason}
          </p>
          <BankMatchPanel
            supabase={supabase}
            payment={{ ...opened, id: opened.payment_id }}
            mark={marks.get(opened.payment_id)}
            canVerify={false}
            canVerifyUrgent={false}
            confirmLabel="Confirm match"
            onChanged={() => { setOpenId(null); onChanged() }}
            onVerified={() => { setOpenId(null); onChanged() }}
          />
        </FinanceModal>
      )}
    </div>
  )
}
