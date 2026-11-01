import { formatAdvancePercent } from '@/lib/orders/draftsView'
import { advanceBelowStandard } from '@/lib/orders/orderListValue'

/** The Advance value: a soft red background below 40%, plain from 40% up, a dash with no figure. */
export function AdvanceCell({ percent }: { percent: number | string | null | undefined }) {
  return (
    <span className={advanceBelowStandard(percent) ? 'orders-advance fin-pill--over' : 'orders-advance'}>
      {formatAdvancePercent(percent)}
    </span>
  )
}
