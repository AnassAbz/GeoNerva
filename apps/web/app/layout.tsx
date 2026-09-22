import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { SiteFooter, SiteHeader } from '../components/site-chrome.tsx';
import './globals.css';

export const metadata: Metadata = {
  title: 'GeoNerva — Understand what’s changing around you',
  description:
    'Open-source, explainable natural-hazard intelligence for the places you care about.',
};

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
