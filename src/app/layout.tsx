import type { Metadata } from 'next'
import { DM_Sans, DM_Mono, Inter } from 'next/font/google'
import { Providers } from '@/components/layout/Providers'
import './globals.css'

// ── Why Syne is no longer fetched here ────────────────────────────────────────
//
// THE BUILD IT BROKE. The production deployment of 3b2291d failed with:
//
//   Turbopack build failed with 12 errors:
//   [next]/internal/font/google/syne_aea35505.module.css:7:8
//   Module not found: Can't resolve
//     '@vercel/turbopack-next/internal/font/google/font'
//
// next/font/google downloads each family AT BUILD TIME and rewrites its CSS to
// point at a module the font loader generates. For Syne that rewrite did not
// resolve on the production builder, and a build that reaches for the network
// can fail for reasons that have nothing to do with the commit — the identical
// tree had built cleanly as a Preview an hour earlier. The other three families
// resolved in the same run, so the risk is not theoretical and not uniform.
//
// WHY THIS IS THE FIX AND NOT A RETRY. Redeploying might well have worked. It
// would also have left the same fetch in the build, to fail again on a day
// nobody is watching. Removing the one family that failed removes the failure
// mode outright, and costs less than it looks like it does — see below.
//
// WHAT IT COSTS, EXACTLY. `--font-display` now resolves to the app's own body
// face, which IS loaded (DM Sans), with a locally-installed Syne preferred
// where one exists. Almost nothing moves: globals.css asked for the family name
// `'Syne'` in .boe-page-title and .boe-kpi-value, while next/font had actually
// registered a scoped name (`__Syne_aea35505`), so those two rules have been
// falling back to the browser's default sans for every reader without Syne
// installed. They now land on DM Sans instead — the app's own typeface rather
// than whatever the operating system supplies.
//
// NO LOCAL SYNE FILE IS ADDED. There is no licensed Syne binary in this
// repository or in node_modules, and fetching one from an unverified source to
// serve as a brand face is not a decision a build fix gets to make. If Syne is
// wanted back, add the licensed file under public/ and switch this to
// next/font/local — which never touches the network at build time.

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-body',
  display: 'swap',
})

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'BOE Operating System',
  description: 'Best of Exports — Internal Operating System',
  manifest: '/manifest.json',
  icons: {
    icon: '/branding/favicon.png',
    apple: '/branding/favicon.png',
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'BOE Operating System',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${dmSans.variable} ${dmMono.variable} ${inter.variable}`}
    >
      <body style={{ fontFamily: 'var(--font-body, DM Sans, sans-serif)' }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}