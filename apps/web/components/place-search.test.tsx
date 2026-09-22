/**
 * The search box, exercised through the four ways in that PRODUCT §4.1 capability 1 names.
 *
 * The API and the browser's geolocation are injected, for the reason the repository injects
 * `navigate`: a component test asserts behaviour, and the modules behind those seams have their
 * own tests — `lib/client/api-client.test.ts` is the one security finding R-7 asks for, and
 * `lib/client/places.test.ts` pins the paths and the schema validation. What only Playwright can
 * prove is the last hop: that a real `/api/v1/places/suggest` over a seeded database answers
 * these calls.
 */

import {
  READ_MODEL_SCHEMA_VERSION,
  type Attribution,
  type LatLon,
  type PlaceSuggestResponse,
} from '@geonerva/domain';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiClientError, type ApiRequest } from '../lib/client/api-client.ts';
import { GeolocationRefused } from '../lib/client/geolocation.ts';
import type { PlacesClient } from '../lib/client/places.ts';
import { PLACE_SUGGESTIONS } from '../lib/fixtures/index.ts';
import { PlaceSearch } from './place-search.tsx';

const ATTRIBUTION: Attribution = {
  sourceId: 'geonames',
  name: 'GeoNames',
  homepage: null,
  licence: 'CC BY 4.0',
  attributionText: 'GeoNames',
  termsUrl: null,
  disclaimer: null,
};

function suggesting(query: string) {
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    query,
    suggestions: PLACE_SUGGESTIONS,
    attribution: [ATTRIBUTION],
  } as const;
}

function found(...labels: readonly (readonly [string, number, number])[]) {
  return {
    schemaVersion: READ_MODEL_SCHEMA_VERSION,
    query: 'q',
    results: labels.map(([label, lat, lon], index) => ({
      key: `n:N${String(index + 1)}`,
      label,
      countryCode: null,
      admin1: null,
      lat,
      lon,
      timezone: 'UTC',
      kind: 'city',
    })),
    fromCache: true,
    attribution: [ATTRIBUTION],
  } as const;
}

/** A client that answers every call the same way. Overridden per test. */
function client(overrides: Partial<PlacesClient> = {}): PlacesClient {
  return {
    suggest: vi.fn((query: string) => Promise.resolve(suggesting(query))),
    search: vi.fn(() => Promise.resolve(found())),
    ...overrides,
  };
}

const box = () => screen.getByRole('combobox', { name: 'Search for a place' });
const status = () => screen.getByRole('status');

describe('PlaceSearch: type-ahead from the API', () => {
  it('asks the suggest endpoint once for a typed word, and navigates with the keyboard', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const places = client();
    render(<PlaceSearch places={places} navigate={navigate} />);

    await user.type(box(), 'Marr');
    expect(await screen.findByRole('option', { name: /Marrakech/u })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(box()).toHaveAttribute('aria-expanded', 'true');
    // Debounced: four keystrokes are one request, and it carries the whole word.
    expect(places.suggest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(places.suggest).mock.calls[0]?.[0]).toBe('Marr');

    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith('/place/marrakech-ma-2542997');
  });

  it('aborts a request the next keystroke has superseded', async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const places = client({
      suggest: vi.fn((query: string, request?: ApiRequest): Promise<PlaceSuggestResponse> => {
        if (request?.signal !== undefined) signals.push(request.signal);
        // The first request never settles, so it is still in flight when the next one is made.
        return query === 'Marr'
          ? new Promise<PlaceSuggestResponse>(() => undefined)
          : Promise.resolve(suggesting(query));
      }),
    });
    render(<PlaceSearch places={places} navigate={vi.fn()} />);

    await user.type(box(), 'Marr');
    await waitFor(() => {
      expect(signals).toHaveLength(1);
    });
    expect(signals[0]?.aborted).toBe(false);

    await user.type(box(), 'a');
    await waitFor(() => {
      expect(signals[0]?.aborted).toBe(true);
    });
  });

  it('keeps the arrow keys and Escape working over the API-supplied list', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    render(<PlaceSearch places={client()} navigate={navigate} />);

    await user.type(box(), 'Marr');
    await screen.findByRole('option', { name: /Marrakech/u });
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(box()).toHaveAttribute('aria-activedescendant', expect.stringContaining('option-0'));
    await user.keyboard('{Escape}');
    expect(box()).toHaveAttribute('aria-expanded', 'false');
  });

  it('degrades to a sentence when the type-ahead cannot be reached', async () => {
    const user = userEvent.setup();
    const places = client({
      suggest: vi.fn(() => Promise.reject(new ApiClientError('UNREACHABLE', 'no'))),
    });
    render(<PlaceSearch places={places} navigate={vi.fn()} />);

    await user.type(box(), 'Marr');
    await waitFor(() => {
      expect(status()).toHaveTextContent('Suggestions are unavailable right now.');
    });
    expect(box()).toBeEnabled();
  });
});

describe('PlaceSearch: submit search', () => {
  it('reaches the geocoder only for a query no suggestion matched, and follows one result', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const places = client({
      suggest: vi.fn((query: string) => Promise.resolve({ ...suggesting(query), suggestions: [] })),
      search: vi.fn(() => Promise.resolve(found(['Sanaa, Yemen', 15.35, 44.21]))),
    });
    render(<PlaceSearch places={places} navigate={navigate} />);

    await user.type(box(), 'Sanaa');
    await waitFor(() => {
      expect(status()).toHaveTextContent('No matching place in the local list.');
    });
    expect(places.search).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Show briefing' }));
    await waitFor(() => {
      expect(places.search).toHaveBeenCalledWith('Sanaa');
    });
    // Addressed by its rounded coordinates: an `n:` key resolves to nothing (see places.test.ts).
    expect(navigate).toHaveBeenCalledWith('/place/@15.35,44.21');
  });

  it('offers the choice when the geocoder found several places', async () => {
    const user = userEvent.setup();
    const places = client({
      suggest: vi.fn((query: string) => Promise.resolve({ ...suggesting(query), suggestions: [] })),
      search: vi.fn(() =>
        Promise.resolve(
          found(['Springfield, Illinois', 39.8, -89.64], ['Springfield, Missouri', 37.21, -93.29]),
        ),
      ),
    });
    render(<PlaceSearch places={places} navigate={vi.fn()} />);

    await user.type(box(), 'Springfield');
    await user.click(screen.getByRole('button', { name: 'Show briefing' }));
    expect(await screen.findByRole('option', { name: /Illinois/u })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Missouri/u })).toBeInTheDocument();
    expect(status()).toHaveTextContent('2 places found.');
  });

  it('shows the API’s own explanation when the geocoder is rate-limited', async () => {
    const user = userEvent.setup();
    const places = client({
      suggest: vi.fn((query: string) => Promise.resolve({ ...suggesting(query), suggestions: [] })),
      search: vi.fn(() =>
        Promise.reject(
          new ApiClientError('PROBLEM', 'rate limited', {
            status: 429,
            problem: {
              type: 'https://geonerva.org/problems/rate-limited',
              title: 'Too many requests',
              status: 429,
              detail: 'The place-search provider is asking GeoNerva to slow down.',
              instance: '/api/v1/places/search',
              code: 'RATE_LIMITED',
              invalidParams: [],
              retryAfterS: 60,
              earliestAsOf: null,
              affectedFamilies: [],
              traceId: null,
            },
          }),
        ),
      ),
    });
    render(<PlaceSearch places={places} navigate={vi.fn()} />);

    await user.type(box(), 'Sanaa');
    await user.click(screen.getByRole('button', { name: 'Show briefing' }));
    await waitFor(() => {
      expect(status()).toHaveTextContent('asking GeoNerva to slow down');
    });
  });
});

describe('PlaceSearch: coordinate entry', () => {
  it('reads a typed pair without asking the API anything at all', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const places = client();
    render(<PlaceSearch places={places} navigate={navigate} />);

    await user.type(box(), '31.63, -8');
    expect(await screen.findByRole('option', { name: 'Go to 31.63, -8.00' })).toBeInTheDocument();
    await user.keyboard('{Enter}');
    expect(navigate).toHaveBeenCalledWith('/place/@31.63,-8.00');
    expect(places.suggest).not.toHaveBeenCalled();
  });

  /*
   * The load-bearing test for invariant I15 on this surface. A precise pair must never become a
   * request, because the URL is the CDN cache key and the platform's access log, neither of which
   * the server can redact after the fact (`lib/server/params.ts`, header).
   */
  it('rounds a precise pair before anything sees it, and never sends it', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const places = client();
    render(<PlaceSearch places={places} navigate={navigate} />);

    await user.type(box(), '48.856614, 2.352222');
    expect(await screen.findByRole('option', { name: 'Go to 48.86, 2.35' })).toBeInTheDocument();
    expect(status()).toHaveTextContent('rounded to two decimals');
    await user.keyboard('{Enter}');

    expect(navigate).toHaveBeenCalledWith('/place/@48.86,2.35');
    expect(places.suggest).not.toHaveBeenCalled();
    expect(places.search).not.toHaveBeenCalled();
    for (const call of vi.mocked(places.suggest).mock.calls) {
      expect(call[0]).not.toContain('856614');
    }
  });

  it('explains a pair that is not on the globe, and one written in degrees and minutes', async () => {
    const user = userEvent.setup();
    const places = client();
    render(<PlaceSearch places={places} navigate={vi.fn()} />);

    await user.type(box(), '91, 0');
    await waitFor(() => {
      expect(status()).toHaveTextContent('A latitude must be between');
    });

    await user.clear(box());
    await user.type(box(), '31:37:48 N, 8:00:00 W');
    await waitFor(() => {
      expect(status()).toHaveTextContent('decimal degrees');
    });
    expect(places.suggest).not.toHaveBeenCalled();
  });
});

describe('PlaceSearch: use my location', () => {
  it('asks only on a click, and rounds before the coordinates reach the URL', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const locate = vi.fn((): Promise<LatLon> => Promise.resolve({ lat: 45.4215, lon: -75.6972 }));
    render(<PlaceSearch places={client()} locate={locate} navigate={navigate} />);

    expect(locate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/place/@45.42,-75.70');
    });
  });

  it('turns a declined prompt into a plain message, not a dead end', async () => {
    const user = userEvent.setup();
    const navigate = vi.fn();
    const locate = vi.fn(() => Promise.reject(new GeolocationRefused('DENIED')));
    render(<PlaceSearch places={client()} locate={locate} navigate={navigate} />);

    await user.click(screen.getByRole('button', { name: 'Use my location' }));
    await waitFor(() => {
      expect(status()).toHaveTextContent('Location permission was declined.');
    });
    expect(navigate).not.toHaveBeenCalled();

    // The box still works afterwards.
    await user.type(box(), 'Marr');
    expect(await screen.findByRole('option', { name: /Marrakech/u })).toBeInTheDocument();
  });

  it('has a message for each way the browser can decline', async () => {
    const cases: readonly (readonly ['UNAVAILABLE' | 'TIMED_OUT' | 'UNSUPPORTED', string])[] = [
      ['UNAVAILABLE', 'could not be determined'],
      ['TIMED_OUT', 'took too long'],
      ['UNSUPPORTED', 'does not offer a location'],
    ];
    for (const [failure, expected] of cases) {
      const user = userEvent.setup();
      const view = render(
        <PlaceSearch
          places={client()}
          locate={() => Promise.reject(new GeolocationRefused(failure))}
          navigate={vi.fn()}
        />,
      );
      await user.click(screen.getByRole('button', { name: 'Use my location' }));
      await waitFor(() => {
        expect(status()).toHaveTextContent(expected);
      });
      view.unmount();
    }
  });
});
