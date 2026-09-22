import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { SiteFooter, SiteHeader } from '../components/site-chrome.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: 'GeoNerva — Understand what’s changing around you',
  description:
    'Open-source, explainable natural-hazard intelligence for the places you care about.',
};

/**
 * Every page is server-rendered on demand (security finding F-5).
 *
 * The strict `script-src` authorises Next's inline bootstrap and flight-data scripts with a
 * per-request nonce, and a nonce has to be inside the document. Prerendered HTML is written at
 * build time, when there is no request and no nonce, and `proxy.ts` alone does not opt a route
 * out of prerendering — measured at Next 16.3.5: `/`, `/methodology` and `/_not-found` were still
 * reported `○ (Static)`, and the served `/` carried two nonce-less inline `<script>` tags against
 * a freshly generated header nonce, which is a blank page. Declaring it on the root layout covers
 * every current and future page from one place. `lib/csp.ts` records the full reasoning, and why
 * hashes cannot replace the nonce here.
 *
 * The cost is confined to `/`, `/methodology` and `/_not-found`, which render no provider text and
 * no per-request data; the four pages that do render provider text were already dynamic, so no
 * CDN-cached HTML (ARCHITECTURE §13.3) is given up. API responses are unaffected.
 */
export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0f14',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-canvas text-fg antialiased">
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
