import Link from 'next/link';

import { COPY } from '../lib/view/copy.ts';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-2xl font-semibold">{COPY.notFound.title}</h1>
      <p className="mt-2 text-fg-muted">{COPY.notFound.body}</p>
      <Link href="/" className="mt-4 inline-flex min-h-11 items-center">
        {COPY.notFound.home}
      </Link>
    </main>
  );
}
