/**
 * `GET /api/v1/briefing` (ARCHITECTURE §13.1).
 *
 * The adapter is deliberately this short. Parse, call the service, serialize, attach the cache
 * policy §13.1 specifies — and nothing else, because everything else already exists somewhere
 * that was tested: validation in `params.ts`, the briefing in `@geonerva/briefing`, the error
 * shape in the frozen problem contract.
 */

import { briefingCacheControl, jsonResponse } from '../../../../lib/server/cache.ts';
import { database } from '../../../../lib/server/db.ts';
import { apiRoute } from '../../../../lib/server/handler.ts';
import {
  parseAsOf,
  parseLocation,
  parseWindow,
  rejectUnknownParams,
} from '../../../../lib/server/params.ts';
import { getBriefing } from '../../../../lib/server/services.ts';

/**
 * §13.1's parameters for this endpoint, and only these.
 *
 * `since` is listed in §13.1 but is not accepted yet: it belongs to the `window=since` mode, whose
 * clamping rule ("`since` is clamped", §13.2) needs the browser's last-visit time and a decision
 * about what to clamp it *to*. Accepting the parameter and ignoring it would be worse than
 * rejecting it — the caller would believe they had asked for a window they did not get.
 */
const ALLOWED = ['place', 'lat', 'lon', 'window', 'as_of'] as const;

export const GET = apiRoute(
  async ({ search, now }) => {
    rejectUnknownParams(search, ALLOWED);

    const location = parseLocation(search);
    const window = parseWindow(search);
    const asOf = parseAsOf(search, now);

    const { briefing } = await getBriefing(database().db, { location, window, asOf, now });

    return jsonResponse(briefing, {
      /*
       * The policy is decided from the same `asOf` the response was built for, so a replay is
       * cached as immutable and a live answer for two minutes. Deciding it from anything else —
       * the presence of the parameter, say — would let a caller ask for `as_of=now` and receive a
       * day-long cache entry for a moving answer.
       */
      cacheControl: briefingCacheControl(asOf, now),
    });
  },
  { name: 'briefing' },
);
