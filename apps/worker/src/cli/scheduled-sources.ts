/**
 * Does the worker's hardcoded job list agree with the database's own switches?
 *
 * Enabling a source takes **two** changes that have to agree: the adapter list in code, and
 * `enabled` on the `source_products` row. Until now nothing checked that, and each direction fails
 * in its own quiet way:
 *
 *  - **Scheduled in code, disabled in the database.** `runIngestion` skips a disabled product
 *    *before* taking the run lease, so no `ingestion_runs` row is written at all — no health
 *    evidence, no coverage, nothing. The job wakes every interval and does nothing, for ever, and
 *    the only trace is an `ingestion.product_disabled` line among thousands.
 *  - **Enabled in the database, absent from the code.** Nothing polls it, so its health decays to
 *    `UNAVAILABLE` and the product advertises itself as something this deployment offers. That
 *    direction is caught from the outside by `scripts/smoke.ts` check 2; this is the inside view.
 *
 * Both are reported at start-up, by name, at `warn`. Deliberately **not** fatal: `DOMAIN_MODEL`
 * makes the database the control surface for switching a feed off, so an operator who disables a
 * misbehaving product must still be able to restart the worker. What must not happen is that the
 * disagreement goes unsaid.
 */

/**
 * Only what the comparison needs, declared here rather than imported.
 *
 * `@geonerva/db` exports two different `SourceProductRow` types — the repository row and an as-of
 * view — and the barrel resolves to the wrong one. A structural type also keeps this a pure
 * function that a unit test can drive with four-field literals instead of a database.
 */
export interface ProductState {
  readonly sourceId: string;
  readonly code: string;
  readonly enabled: boolean;
  readonly status: string;
}

export interface ScheduledFeed {
  readonly sourceId: string;
  readonly productCode: string;
}

export interface SourceStateMismatch {
  /** Scheduled by this build, switched off in the database: the job will do nothing. */
  readonly scheduledButOff: readonly string[];
  /** Enabled in the database, polled by nothing: it will read `UNAVAILABLE`. */
  readonly enabledButUnscheduled: readonly string[];
}

function label(sourceId: string, productCode: string): string {
  return `${sourceId}:${productCode}`;
}

/**
 * Compares the scheduled feeds against the products the database says are live.
 *
 * `products` is expected to be every product **including** disabled and retired ones, so that both
 * directions can be seen; a caller passing only the enabled ones would see half the picture.
 */
export function findSourceStateMismatch(
  scheduled: readonly ScheduledFeed[],
  products: readonly ProductState[],
  enabledSourceIds: ReadonlySet<string>,
): SourceStateMismatch {
  const byLabel = new Map(
    products.map((product) => [label(product.sourceId, product.code), product]),
  );
  const scheduledLabels = new Set(scheduled.map((feed) => label(feed.sourceId, feed.productCode)));

  const scheduledButOff: string[] = [];
  for (const feed of scheduled) {
    const key = label(feed.sourceId, feed.productCode);
    const product = byLabel.get(key);
    if (product === undefined) {
      /*
       * Not a drift but a worse thing: the build polls a product the database has never heard of.
       * `runIngestion` already fails that as `CONFIG_ERROR`, so it is named here too rather than
       * left to be discovered one interval later.
       */
      scheduledButOff.push(`${key} (no such product)`);
      continue;
    }
    if (!enabledSourceIds.has(product.sourceId)) {
      scheduledButOff.push(`${key} (source disabled)`);
      continue;
    }
    if (!product.enabled) scheduledButOff.push(`${key} (product disabled)`);
    else if (product.status === 'RETIRED') scheduledButOff.push(`${key} (retired)`);
  }

  const enabledButUnscheduled = products
    .filter(
      (product) =>
        product.enabled &&
        product.status !== 'RETIRED' &&
        enabledSourceIds.has(product.sourceId) &&
        !scheduledLabels.has(label(product.sourceId, product.code)),
    )
    .map((product) => label(product.sourceId, product.code));

  return { scheduledButOff, enabledButUnscheduled };
}

/** The lines to log, or an empty array when code and database agree. */
export function describeSourceStateMismatch(mismatch: SourceStateMismatch): string[] {
  const lines: string[] = [];
  if (mismatch.scheduledButOff.length > 0) {
    lines.push(
      `scheduled but switched off, so these jobs will do nothing: ${mismatch.scheduledButOff.join(', ')}`,
    );
  }
  if (mismatch.enabledButUnscheduled.length > 0) {
    lines.push(
      `enabled in the database but polled by nothing, so these will read UNAVAILABLE: ${mismatch.enabledButUnscheduled.join(', ')}`,
    );
  }
  return lines;
}
