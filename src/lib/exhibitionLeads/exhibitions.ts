import { isCalendarDate } from '@/lib/listState'
import { MAX_CITY, MAX_NAME } from './validation'

// The Add / Edit exhibition form. The database enforces the same rules
// (create_exhibition / update_exhibition); this copy lets the form say so before
// a round trip.

export const MAX_EXHIBITION_DAYS = 31

export type ExhibitionFormValues = {
  name: string
  city: string
  startsOn: string
  endsOn: string
  isActive: boolean
}

export type ExhibitionFormErrors = Partial<Record<'name' | 'city' | 'startsOn' | 'endsOn', string>>

/** Whole days between two YYYY-MM-DD dates (UTC arithmetic: these are plain calendar dates). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

export function validateExhibitionForm(v: ExhibitionFormValues): ExhibitionFormErrors {
  const e: ExhibitionFormErrors = {}
  const name = v.name.trim()
  if (!name) e.name = 'Enter the exhibition name'
  else if (name.length > MAX_NAME) e.name = `At most ${MAX_NAME} characters`
  if (v.city.trim().length > MAX_CITY) e.city = `At most ${MAX_CITY} characters`
  if (!v.startsOn || !isCalendarDate(v.startsOn)) e.startsOn = 'Choose the first day'
  if (!v.endsOn || !isCalendarDate(v.endsOn)) e.endsOn = 'Choose the last day'
  if (!e.startsOn && !e.endsOn) {
    const span = daysBetween(v.startsOn, v.endsOn)
    if (span < 0) e.endsOn = 'The last day cannot be before the first day'
    else if (span + 1 > MAX_EXHIBITION_DAYS) e.endsOn = `An exhibition can run for at most ${MAX_EXHIBITION_DAYS} days`
  }
  return e
}
