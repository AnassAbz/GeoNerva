/**
 * `GET /api/v1/replay/horizon` (ARCHITECTURE §13.1).
 *
 * The earliest replayable time per family, derived from the retention profile (ADR-035). It takes
 * no parameters and reads no facts — the profile and the clock decide it — which is why it is the
 * one endpoint a client can call to discover the bounds of every *other* endpoint's `as_of`.
 */

import { CACHE_POLICIES, jsonResponse } from '../../../../../lib/server/cache.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import { rejectUnknownParams } from '../../../../../lib/server/params.ts';
import { getReplayHorizon } from '../../../../../lib/server/services.ts';

export const GET = apiRoute(
  ({ search, now }) => {
    rejectUnknownParams(search, []);
    return Promise.resolve(
      jsonResponse(getReplayHorizon(now), { cacheControl: CACHE_POLICIES.replayHorizon }),
    );
  },
  /*
   * `default` — §13.4's "everything else". The limiter fails open when the counter cannot be
   * written, which is what keeps this endpoint answerable with no database: it reads no facts, so
   * the counter is the only thing it would have needed one for.
   */
  { name: 'replay-horizon', rateLimit: 'default' },
);
