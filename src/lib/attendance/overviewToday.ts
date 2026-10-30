// The Overview's one line about today, from the same machine day the Today tab
// reads. Pure, so the wording can be tested.

import { formatPunchMoment } from '../minop/machineHealth'
import type { MachineDayView } from '../minop/machineDayView'

export type TodayLine = { lead: string; detail: string; stopped: boolean }

export function todayLine(view: MachineDayView): TodayLine {
  const { health, entries } = view
  const last = health.lastPunch ? formatPunchMoment(health.lastPunch.punchAt, health.today) : null
  const lastPunch = last ? `Last punch ${last}.` : 'No punch has reached BOE yet.'

  if (health.state === 'stopped') {
    return { lead: 'Machine has stopped sending.', detail: `No punch has reached BOE today. ${last ? `The last one was ${last}.` : ''}`.trim(), stopped: true }
  }
  if (health.state === 'day_off') return { lead: 'Day off today.', detail: lastPunch, stopped: false }

  // Someone with no Machine ID, on leave or on their day off is not expected.
  const expected = entries.filter(e => e.status !== 'day_off' && e.status !== 'on_leave' && e.status !== 'no_machine_id')
  const punched = expected.filter(e => e.checkInAt || e.checkOutAt).length
  const late = expected.filter(e => e.lateMinutes !== null).length
  const lateNote = late > 0 ? `, ${late} late so far` : ''

  return {
    lead: `Today: ${punched} of ${expected.length} ${expected.length === 1 ? 'person has' : 'people have'} punched in${lateNote}.`,
    detail: health.state === 'sending' ? `Machine is sending. ${lastPunch}` : lastPunch,
    stopped: false,
  }
}
