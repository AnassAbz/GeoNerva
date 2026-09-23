/**
 * The event timeline: one deterministic sentence per version, saying what that version changed
 * (`EventDetail.timeline`, DOMAIN_MODEL §4.8).
 *
 * A version exists only where the provider's content hash changed (ADR-029), so every entry after
 * the first is a revision — and the useful thing to say about a revision is *which values moved*.
 * This module compares a version with the previous version **of the same record** and names the
 * fields GeoNerva shows: magnitude, depth, epicentre, origin time, lifecycle, alert level and the
 * provider's review status. A version that changed only something GeoNerva does not display — a
 * title, an attribute bag — says so rather than inventing a change.
 *
 * Pure and deterministic: the same two versions always produce the same words, which is what
 * makes the timeline part of a replay rather than a rendering detail.
 */

import type {
  FactValue,
  LifecycleStatus,
  ProviderSeverity,
  RevisionChangeCode,
} from '@geonerva/domain';
import { statedKilometres, vincentyDistanceMeters } from '@geonerva/geo';

/** The values of one version that the timeline compares. */
export interface VersionValues {
  readonly observedAt: Date;
  readonly lifecycleStatus: LifecycleStatus;
  readonly magnitude: number | null;
  readonly magnitudeType: string | null;
  readonly depthKm: number | null;
  readonly lat: number;
  readonly lon: number;
  readonly severity: ProviderSeverity | null;
  readonly providerStatus: string | null;
}

export interface RevisionDescription {
  readonly summary: string;
  readonly changedFields: readonly string[];
  readonly changes: readonly {
    readonly code: string;
    readonly label: string;
    readonly before: FactValue | null;
    readonly after: FactValue | null;
  }[];
}

/**
 * Below this, an epicentre "move" is relocation noise in the provider's own solution rather than
 * something a reader should be told about. It is the same half-kilometre the stated distances are
 * rounded to below 10 km (`statedKilometres`), so a move this function reports is always one a
 * distance elsewhere in the product could show.
 */
export const EPICENTRE_MOVE_THRESHOLD_M = 500;

/**
 * Describes one version.
 *
 * `previous` is the prior version of the **same record**, or `null` for the first one. Comparing
 * across records would describe the difference between two agencies as a revision, which is what
 * `agreement` exists to show instead.
 */
export function describeRevision(
  sourceName: string,
  previous: VersionValues | null,
  current: VersionValues,
): RevisionDescription {
  if (previous === null) {
    const magnitude = current.magnitude === null ? '' : ` as ${formatMagnitude(current.magnitude)}`;
    return {
      summary: `${sourceName} first reported it${magnitude}.`,
      changedFields: [],
      changes: [],
    };
  }

  const clauses: string[] = [];
  const changedFields: string[] = [];
  const changes: RevisionDescription['changes'][number][] = [];

  if (current.lifecycleStatus !== previous.lifecycleStatus) {
    changedFields.push('lifecycleStatus');
    changes.push({
      code: 'LIFECYCLE' satisfies RevisionChangeCode,
      label: 'Status',
      before: { kind: 'text', value: previous.lifecycleStatus },
      after: { kind: 'text', value: current.lifecycleStatus },
    });
    clauses.push(lifecycleClause(previous.lifecycleStatus, current.lifecycleStatus));
  }

  if (current.magnitude !== previous.magnitude) {
    changedFields.push('magnitude');
    changes.push({
      code: 'MAGNITUDE' satisfies RevisionChangeCode,
      label: 'Magnitude',
      before: magnitudeValue(previous.magnitude),
      after: magnitudeValue(current.magnitude),
    });
    clauses.push(
      current.magnitude === null
        ? 'withdrew the magnitude'
        : previous.magnitude === null
          ? `gave a magnitude of ${formatMagnitude(current.magnitude)}`
          : `revised the magnitude from ${formatMagnitude(previous.magnitude)} to ${formatMagnitude(current.magnitude)}`,
    );
  }

  if (current.depthKm !== previous.depthKm) {
    changedFields.push('depthKm');
    changes.push({
      code: 'DEPTH' satisfies RevisionChangeCode,
      label: 'Depth',
      before: depthValue(previous.depthKm),
      after: depthValue(current.depthKm),
    });
    clauses.push(
      current.depthKm === null
        ? 'withdrew the depth'
        : previous.depthKm === null
          ? `gave a depth of ${formatDepth(current.depthKm)}`
          : `revised the depth from ${formatDepth(previous.depthKm)} to ${formatDepth(current.depthKm)}`,
    );
  }

  const movedM = vincentyDistanceMeters(
    { lat: previous.lat, lon: previous.lon },
    { lat: current.lat, lon: current.lon },
  );
  if (movedM !== null && movedM >= EPICENTRE_MOVE_THRESHOLD_M) {
    const km = statedKilometres(movedM);
    changedFields.push('centroid');
    changes.push({
      code: 'EPICENTRE_MOVED' satisfies RevisionChangeCode,
      label: 'Location moved by',
      before: null,
      after: { kind: 'number', value: km, unit: 'km', decimals: km >= 10 ? 0 : 1 },
    });
    clauses.push(`moved the location by ${formatKm(km)}`);
  }

  if (current.observedAt.getTime() !== previous.observedAt.getTime()) {
    changedFields.push('observedAt');
    changes.push({
      code: 'OBSERVED_AT' satisfies RevisionChangeCode,
      label: 'Reported time',
      before: { kind: 'timestamp', value: previous.observedAt.toISOString() },
      after: { kind: 'timestamp', value: current.observedAt.toISOString() },
    });
    clauses.push('revised the time of the event');
  }

  if (!sameSeverity(previous.severity, current.severity)) {
    changedFields.push('severity');
    changes.push({
      code: 'SEVERITY' satisfies RevisionChangeCode,
      label: 'Alert level',
      before: previous.severity === null ? null : { kind: 'severity', severity: previous.severity },
      after: current.severity === null ? null : { kind: 'severity', severity: current.severity },
    });
    clauses.push(
      current.severity === null
        ? 'withdrew its alert level'
        : previous.severity === null
          ? `issued an alert level of ${current.severity.value}`
          : `changed its alert level from ${previous.severity.value} to ${current.severity.value}`,
    );
  }

  if (current.providerStatus !== previous.providerStatus) {
    changedFields.push('providerStatus');
    changes.push({
      code: 'PROVIDER_STATUS' satisfies RevisionChangeCode,
      label: 'Review status',
      before:
        previous.providerStatus === null ? null : { kind: 'text', value: previous.providerStatus },
      after:
        current.providerStatus === null ? null : { kind: 'text', value: current.providerStatus },
    });
    clauses.push(
      current.providerStatus === null
        ? 'withdrew its review status'
        : `marked it ${current.providerStatus}`,
    );
  }

  if (clauses.length === 0) {
    return {
      summary: `${sourceName} updated its record without changing the values GeoNerva shows.`,
      changedFields,
      changes,
    };
  }
  return { summary: `${sourceName} ${joinClauses(clauses)}.`, changedFields, changes };
}

/**
 * `ACTIVE` and `UPDATED` are both live. Moving between them is an update; moving back to either
 * from an ending is a reinstatement, and only that deserves "current again".
 */
function lifecycleClause(previous: LifecycleStatus, status: LifecycleStatus): string {
  switch (status) {
    case 'DELETED':
      return 'withdrew the record';
    case 'MISSING_FROM_SOURCE':
      return 'stopped listing the record';
    case 'ENDED':
      return 'marked it ended';
    case 'CANCELLED':
      return 'cancelled it';
    case 'EXPIRED':
      return 'let it expire';
    case 'ACTIVE':
    case 'UPDATED':
      return previous === 'ACTIVE' || previous === 'UPDATED'
        ? 'marked it updated'
        : 'marked it current again';
  }
}

/** "a, b and c". Two clauses are "a and b"; one is itself. */
function joinClauses(clauses: readonly string[]): string {
  if (clauses.length <= 1) return clauses.join('');
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1] ?? ''}`;
}

function sameSeverity(left: ProviderSeverity | null, right: ProviderSeverity | null): boolean {
  if (left === null || right === null) return left === right;
  return left.scheme === right.scheme && left.value === right.value;
}

function magnitudeValue(value: number | null): FactValue | null {
  return value === null ? null : { kind: 'number', value, unit: null, decimals: 1 };
}

function depthValue(value: number | null): FactValue | null {
  return value === null ? null : { kind: 'number', value, unit: 'km', decimals: 0 };
}

function formatMagnitude(value: number): string {
  return `M${value.toFixed(1)}`;
}

function formatDepth(value: number): string {
  return `${value.toFixed(0)} km`;
}

function formatKm(km: number): string {
  return `${km >= 10 ? km.toFixed(0) : km.toFixed(1)} km`;
}
