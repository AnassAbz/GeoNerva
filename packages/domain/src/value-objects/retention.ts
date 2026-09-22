/**
 * Retention windows that more than one process must agree on (ADR-033).
 *
 * The worker's retention job removes what these windows say to remove, and the read side reports
 * what was removed. They are one table, here, so the two can never disagree about when a body
 * expired.
 */

/** The storage profile a deployment runs (ADR-035). `lean` is the v1 choice (owner Q2). */
export type RetentionProfile = 'lean' | 'standard';

/** Days a **live** raw payload body is kept (ADR-033). Backfilled bodies are never stored. */
export const LIVE_PAYLOAD_RETENTION_DAYS: Readonly<Record<RetentionProfile, number>> = {
  lean: 30,
  standard: 90,
};
