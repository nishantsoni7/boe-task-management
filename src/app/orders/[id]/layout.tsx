// A CONFIRMED ORDER'S PAGE IS PREPARED ONCE, THEN SERVED FROM THE CACHE (2026-10-22).
//
// This page is identical for every Order: it is a client component that reads its data in the
// browser, after it loads, under the signed-in person's own access. Yet every route with a dynamic
// segment is, by default, rendered by a server function on EVERY navigation. Measured on the live
// site: opening an Order first waited about 260-400 ms for that function (and, after it had been idle,
// once 10.6 s for a cold start) before the browser could so much as ask for the Order's data, and the
// link's prefetch could not help, because Next does not prefetch a dynamic page.
//
// Returning an empty list here tells Next to prepare no Order at build time but to prepare each one
// the first time it is asked for and keep it (Next: generateStaticParams, "all paths at runtime").
// From then on the page is a cached file, so the link's hover prefetch really fetches it, and opening
// an Order starts its data reads straight away, as the lists do.
//
// NOTHING PRIVATE IS CACHED. There is no Order data in this page's server output: that arrives from
// the database in the browser, scoped by RLS to the reader. If anything in this route's tree ever
// read cookies or headers on the server, Next would refuse to cache it and the page would simply go
// back to being dynamic, so this cannot turn a personal page into a shared one.

export function generateStaticParams() {
  return []
}

export default function OrderRecordLayout({ children }: { children: React.ReactNode }) {
  return children
}
