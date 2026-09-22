/**
 * `GET /api/v1/evidence/{id}` (ARCHITECTURE §13.1).
 *
 * §13.1 caches this "immutable", and the reason that was given here — "every primary evidence kind
 * points at an append-only row that cannot change once written" — was **wrong for two of the four
 * kinds**. A correlation link is updated in place when it is withdrawn, and an ingestion run is
 * updated when it finishes or has its lease expired. `evidenceCacheControl` explains the
 * consequence and the condition under which `immutable` is actually true.
 */

import { evidenceCacheControl, jsonResponse } from '../../../../../lib/server/cache.ts';
import { database } from '../../../../../lib/server/db.ts';
import { apiRoute } from '../../../../../lib/server/handler.ts';
import {
  MAX_EVIDENCE_ID_LENGTH,
  parseAsOf,
  rejectUnknownParams,
} from '../../../../../lib/server/params.ts';
import { lastPathSegment } from '../../../../../lib/server/path.ts';
import { ApiProblemError } from '../../../../../lib/server/problem.ts';
import { getEvidence } from '../../../../../lib/server/services.ts';

const ALLOWED = ['as_of'] as const;

export const GET = apiRoute(
  async ({ search, now, url }) => {
    rejectUnknownParams(search, ALLOWED);
    const asOf = parseAsOf(search, now);

    /*
     * The id is taken from the path rather than from Next's params object, so this handler is
     * testable by constructing a `Request` alone. It is length-capped before `getEvidence` parses
     * it, because the id reaches a `LIKE`-free but still parameterised query and an unbounded path
     * segment is an unbounded cache key.
     */
    const raw = lastPathSegment(url);
    if (raw === null || raw === '' || raw.length > MAX_EVIDENCE_ID_LENGTH) {
      throw new ApiProblemError({
        code: 'VALIDATION_FAILED',
        detail: 'The evidence identifier is missing or too long.',
        invalidParams: [
          { name: 'id', reason: `must be 1 to ${String(MAX_EVIDENCE_ID_LENGTH)} characters` },
        ],
      });
    }

    /*
     * The whole `EvidenceDetail` — the manifest entry, the typed payload for its kind, and the
     * attribution its licence requires. Serializing only the entry would return a manifest row
     * from an endpoint whose contract is the resolved record, which is what this adapter did
     * before the frozen model was read properly.
     */
    const detail = await getEvidence(database().db, { id: raw, asOf, now });
    return jsonResponse(detail, { cacheControl: evidenceCacheControl(asOf, now) });
  },
  { name: 'evidence', rateLimit: 'default' },
);
