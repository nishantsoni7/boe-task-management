'use client'

import { ReceivedPaymentsView } from '../ReceivedPaymentsView'

// Received payments linked to either an Order or an Order Request —
// order_id IS NOT NULL OR order_request_id IS NOT NULL. Both count as allocated:
// a payment parked on an Order Request already belongs to a piece of business,
// and 20260698's linkage transfers itself to the Order on conversion.
export default function LinkedPaymentsPage() {
  return <ReceivedPaymentsView mode="linked" />
}
