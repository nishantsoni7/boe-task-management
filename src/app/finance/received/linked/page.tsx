'use client'

// /finance/received/linked — retired route, kept answerable.
//
// Linked Payments and Non-Linked Payments were sibling lists until the canonical
// classification replaced the pair with four overlapping views on one route (see
// ../page.tsx). This route stays so existing bookmarks, the Finance sidebar's old
// entries and any link in somebody's message land on the list rather than on a
// 404 — and it forwards the query string untouched, so a `?payment=` deep link
// still opens the record it names.
//
// `all` and not `orders`: "linked" meant Orders OR PI Drafts OR a retired Order
// Request, and no single view is that set. All is the honest landing — the tabs
// are right there, and nothing is hidden behind the wrong one.

import { RetiredReceivedRoute } from '../RetiredReceivedRoute'

export default function LinkedPaymentsRedirect() {
  return <RetiredReceivedRoute view="all" />
}
