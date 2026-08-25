// ── The four BOE accounts, as icons ───────────────────────────────────────────
//
// All that survives of the account-based "Payment Destination" control. Both
// payment-entry forms now ask for the canonical five-value Payment Mode instead
// (20261013000000), so nothing CHOOSES an account any more — but rows recorded
// before that still carry a (payment_mode, received_in) pair naming one, and
// the screens that read those rows back still draw its icon.
//
// Decorative in every use: each icon sits beside its own visible label, and
// nothing is distinguished by the icon — or by colour — alone.

import { HandCoins, Landmark, PiggyBank, Users, type LucideIcon } from 'lucide-react'
import type { BoeAccount } from '../paymentDestinations'

export const DESTINATION_ICON: Record<BoeAccount['iconKey'], LucideIcon> = {
  'landmark':   Landmark,
  'piggy-bank': PiggyBank,
  'hand-coins': HandCoins,
  'users':      Users,
}
