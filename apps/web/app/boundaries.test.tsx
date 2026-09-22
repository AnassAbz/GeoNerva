/**
 * The loading and failure boundaries, at the level a component test can reach them.
 *
 * What these cover: that a skeleton states no value, announces itself and takes no focus; that a
 * failure explains itself, offers a retry that calls `reset`, and never puts the thrown error on
 * the page; and that the retention refusal gets its own wording rather than the failure's.
 *
 * What only E2E can prove is listed in the handoff: that Next actually mounts each `loading.tsx`
 * during a real navigation, that the skeleton and the content occupy the same box, that focus is
 * still where the reader left it after the content streams in, and that a production build's
 * redaction never reaches the reader as a retention sentence.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { COPY } from '../lib/view/copy.ts';
import { FAMILY_ORDER } from '../lib/view/families.ts';
import DataStatusError from './data-status/error.tsx';
import LoadingDataStatus from './data-status/loading.tsx';
import AppError from './error.tsx';
import EventError from './event/[publicId]/error.tsx';
import LoadingEvent from './event/[publicId]/loading.tsx';
import FireError from './fire/[publicId]/error.tsx';
import LoadingFire from './fire/[publicId]/loading.tsx';
import PlaceError from './place/[slug]/error.tsx';
import LoadingPlace from './place/[slug]/loading.tsx';

/* The boundary reads the current path from the router to offer "return to the present". */
vi.mock('next/navigation', () => ({ usePathname: () => '/place/marrakech-ma-2542997' }));

const PATHNAME = '/place/marrakech-ma-2542997';

interface SkeletonCase {
  readonly name: string;
  readonly Component: () => ReactElement;
  readonly label: string;
}

const SKELETONS: readonly SkeletonCase[] = [
  { name: 'the dashboard', Component: LoadingPlace, label: COPY.loading.briefing },
  { name: 'an event', Component: LoadingEvent, label: COPY.loading.event },
  { name: 'a fire activity cluster', Component: LoadingFire, label: COPY.loading.fire },
  { name: 'data status', Component: LoadingDataStatus, label: COPY.loading.dataStatus },
];

describe.each(SKELETONS)('the skeleton for $name', ({ Component, label }) => {
  it('announces the wait in a polite live region', () => {
    render(<Component />);
    expect(screen.getByRole('status')).toHaveTextContent(label);
  });

  it('states no value: not one digit reaches the page', () => {
    const { container } = render(<Component />);
    expect(container.textContent).not.toMatch(/\d/u);
  });

  it('holds nothing focusable, so focus stays where the reader left it', () => {
    const { container } = render(<Component />);
    const focusable = container.querySelectorAll('a, button, input, select, textarea, [tabindex]');
    expect(focusable).toHaveLength(0);
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps the skip link’s target, so the header still reaches the content', () => {
    const { container } = render(<Component />);
    expect(container.querySelector('main#main')).not.toBeNull();
  });

  it('hides every placeholder shape from assistive technology', () => {
    const { container } = render(<Component />);
    const shapes = container.querySelectorAll('div.bg-raised, div.bg-surface');
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) expect(shape).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('the dashboard skeleton', () => {
  it('lays out the regions of PRODUCT §6.2 in the grid the page uses', () => {
    const { container } = render(<LoadingPlace />);
    expect(container.querySelector('main')?.className).toContain('max-w-7xl');
    for (const heading of [
      COPY.changes.title,
      COPY.map.title,
      COPY.nearby.title,
      COPY.history.title,
      COPY.sources.title,
    ]) {
      expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    }
  });

  it('reserves one card per hazard family, so the column does not grow under the reader', () => {
    const { container } = render(<LoadingPlace />);
    expect(container.querySelectorAll('section.space-y-3 > div')).toHaveLength(FAMILY_ORDER.length);
  });

  it('reserves the map panel’s own box at both viewports', () => {
    const { container } = render(<LoadingPlace />);
    const box = container.querySelector('[class*="70vh"]');
    expect(box).not.toBeNull();
    expect(box?.className).toContain('h-[200px]');
  });
});

interface BoundaryProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
}

interface BoundaryCase {
  readonly name: string;
  readonly Component: (props: BoundaryProps) => ReactElement;
  readonly title: string;
}

const BOUNDARIES: readonly BoundaryCase[] = [
  { name: '/place/[slug]', Component: PlaceError, title: COPY.failure.briefingTitle },
  { name: '/event/[publicId]', Component: EventError, title: COPY.failure.eventTitle },
  { name: '/fire/[publicId]', Component: FireError, title: COPY.failure.fireTitle },
  { name: '/data-status', Component: DataStatusError, title: COPY.failure.dataStatusTitle },
  { name: 'the root segment', Component: AppError, title: COPY.failure.pageTitle },
];

/** A failure carrying everything a boundary must not show: a relation, a host, a stack, a digest. */
function databaseFailure(): Error & { digest?: string } {
  const error = new Error('relation "public.canonical_event" does not exist at db.internal:5432');
  error.stack = 'Error: relation "public.canonical_event"\n    at Object.query (/srv/app/pg.js:1)';
  return Object.assign(error, { digest: '3735928559' });
}

const noop = (): void => undefined;

describe.each(BOUNDARIES)('the failure boundary for $name', ({ Component, title }) => {
  it('says what failed, and announces that the content was replaced', () => {
    render(<Component error={databaseFailure()} reset={noop} />);
    expect(screen.getByRole('alert')).toHaveTextContent(title);
  });

  it('shows no stack trace, database message, host or digest', () => {
    const { container } = render(<Component error={databaseFailure()} reset={noop} />);
    const text = container.textContent;
    for (const leak of ['relation', 'canonical_event', 'db.internal', 'pg.js', '3735928559']) {
      expect(text).not.toContain(leak);
    }
  });

  it('offers a retry that re-renders the segment', async () => {
    const user = userEvent.setup();
    const reset = vi.fn();
    render(<Component error={databaseFailure()} reset={reset} />);
    await user.click(screen.getByRole('button', { name: COPY.failure.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('gives every affordance a ≥ 44 px target', () => {
    const { container } = render(<Component error={databaseFailure()} reset={noop} />);
    const controls = container.querySelectorAll('a, button');
    expect(controls.length).toBeGreaterThan(1);
    for (const control of controls) expect(control.className).toContain('min-h-11');
  });

  it('takes no focus, so a reset does not strand it', () => {
    render(<Component error={databaseFailure()} reset={noop} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('a retention refusal at a boundary', () => {
  function refusal(): Error & { digest?: string } {
    return Object.assign(new Error('AS_OF_BEFORE_HORIZON: not held that far back'), {
      problem: { code: 'AS_OF_BEFORE_HORIZON' },
    });
  }

  it('is reported as retention, not as a fault and not as an absence', () => {
    render(<PlaceError error={refusal()} reset={noop} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      COPY.failure.retentionTitle,
    );
    expect(screen.getByText(COPY.failure.retentionBody)).toBeInTheDocument();
    expect(screen.queryByText(COPY.failure.briefingTitle)).not.toBeInTheDocument();
    expect(screen.queryByText(COPY.notFound.title)).not.toBeInTheDocument();
  });

  it('offers the present instead of a retry that could only refuse again', () => {
    render(<PlaceError error={refusal()} reset={noop} />);
    expect(screen.queryByRole('button', { name: COPY.failure.retry })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: COPY.failure.retentionExit })).toHaveAttribute(
      'href',
      PATHNAME,
    );
  });
});

describe('the link to the health of every source', () => {
  it('is not offered by /data-status, which is the page that just failed', () => {
    render(<DataStatusError error={databaseFailure()} reset={noop} />);
    expect(
      screen.queryByRole('link', { name: COPY.failure.dataStatusLink }),
    ).not.toBeInTheDocument();
  });

  it('is offered by the boundaries that are not it', () => {
    render(<PlaceError error={databaseFailure()} reset={noop} />);
    expect(screen.getByRole('link', { name: COPY.failure.dataStatusLink })).toHaveAttribute(
      'href',
      '/data-status',
    );
  });
});
