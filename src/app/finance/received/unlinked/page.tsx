'use client'

// /finance/received/unlinked — retired route, kept answerable.
//
// This page held "money with nothing at all pointing at it". Its successor is
// the Available view, which is that set AND MORE: it also holds partly allocated
// payments with a balance left over, and money parked on a retired Order Request
// that nothing will ever come to collect. Both need somebody, and neither was
// on this page.
//
// The query string is forwarded untouched, so a `?payment=…&action=allocate`
// deep link from the Admin Action Queue still opens the record it names.

import { RetiredReceivedRoute } from '../RetiredReceivedRoute'

export default function NonLinkedPaymentsRedirect() {
  return <RetiredReceivedRoute view="available" />
}
