/**
 * Formatting for read-model values. Pure functions, used by server and client components alike.
 *
 * Two rules from the contract shape this module:
 *  - `FactValue` of kind `unavailable` is rendered as words, never as an empty cell or a zero
 *    (invariant I11).
 *  - `number` values carry their own decimals, so 5.30 never becomes 5.3.
 */

import type {
  ChangeWindow,
  DataConfidenceLevel,
  FactValue,
  HazardType,
  LifecycleStatus,
  RelevanceLevel,
  SeverityScheme,
  UnavailableReason,
} from '@geonerva/domain';

const UNAVAILABLE_WORDS: Readonly<Record<UnavailableReason, string>> = {
  NOT_REPORTED_BY_SOURCE: 'Not reported by the source',
  SOURCE_UNAVAILABLE: 'Source unavailable',
  NOT_COVERED: 'Not covered here',
  INSUFFICIENT_HISTORY: 'Not enough history',
  NOT_APPLICABLE: 'Does not apply',
  BEYOND_REPLAY_HORIZON: 'Beyond the replay horizon',
};

const SEVERITY_SCHEME_LABEL: Readonly<Record<SeverityScheme, string>> = {
  GDACS_ALERT: 'GDACS',
  PAGER: 'PAGER',
  ECCC_RISK_COLOUR: 'ECCC',
  CAP_SEVERITY: 'CAP',
};

export function unavailableWords(reason: UnavailableReason): string {
  return UNAVAILABLE_WORDS[reason];
}

export function formatNumber(value: number, decimals: number): string {
  return new Intl.NumberFormat('en-GB', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Renders one fact value. `timeZone` is used for timestamps. */
export function formatFactValue(value: FactValue, timeZone = 'UTC'): string {
  switch (value.kind) {
    case 'number': {
      const number = formatNumber(value.value, value.decimals);
      return value.unit === null ? number : `${number} ${value.unit}`;
    }
    case 'count':
      return formatNumber(value.value, 0);
    case 'text':
      return value.value;
    case 'severity':
      return `${SEVERITY_SCHEME_LABEL[value.severity.scheme]} ${value.severity.value}`;
    case 'timestamp':
      return formatDateTime(value.value, timeZone);
    case 'boolean':
      return value.value ? 'Yes' : 'No';
    case 'unavailable':
      return unavailableWords(value.reason);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "22 Sep 2026" in the given time zone. Month names are GeoNerva's own, not ICU's, so the form
 * does not change between runtimes (en-GB ICU data spells September "Sept").
 */
export function formatDay(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    year: 'numeric',
    timeZone,
  }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${String(Number(part('day')))} ${MONTHS[Number(part('month')) - 1] ?? ''} ${part('year')}`;
}

/** "14:02, 22 Sep 2026" in the given time zone. */
export function formatDateTime(iso: string, timeZone: string): string {
  return `${formatClock(iso, timeZone)}, ${formatDay(iso, timeZone)}`;
}

/** "14:02" in the given time zone. */
export function formatClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone,
  }).format(new Date(iso));
}

/** "12:10 UTC, 8 Sep 2026" — the replay banner's form. */
export function formatUtc(iso: string): string {
  return `${formatClock(iso, 'UTC')} UTC, ${formatDay(iso, 'UTC')}`;
}

/** A duration in seconds, in the largest unit that reads naturally: "90 min", "3 h", "2 d". */
export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return `${String(Math.max(0, Math.round(seconds)))} s`;
  if (minutes < 120 && minutes % 60 !== 0) return `${String(minutes)} min`;
  const hours = seconds / 3600;
  if (hours < 48) {
    const whole = Math.floor(hours);
    const rest = Math.round((hours - whole) * 60);
    return rest === 0 ? `${String(whole)} h` : `${String(whole)} h ${String(rest)} min`;
  }
  return `${String(Math.round(hours / 24))} d`;
}

/** "4 min ago", "3 h 40 min ago", "2 d ago"; "just now" under a minute. */
export function formatAgo(iso: string, now: string | Date): string {
  const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime();
  const seconds = (nowMs - Date.parse(iso)) / 1000;
  if (seconds < 60) return 'just now';
  return `${formatDuration(seconds)} ago`;
}

export function formatDistanceKm(km: number): string {
  return `${formatNumber(km, km < 10 ? 1 : 0)} km`;
}

export const RELEVANCE_LABEL: Readonly<Record<RelevanceLevel, string>> = {
  LOW: 'Low',
  MODERATE: 'Moderate',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

export const CONFIDENCE_LABEL: Readonly<Record<DataConfidenceLevel, string>> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
};

/** Hazard types in words. FIRMS detections are "fire activity", never a wildfire (PRODUCT §7). */
export const HAZARD_LABEL: Readonly<Record<HazardType, string>> = {
  EARTHQUAKE: 'Earthquake',
  THERMAL_ACTIVITY: 'Fire activity (satellite thermal detections)',
  WILDFIRE_EVENT: 'GDACS burnt-area event',
  FLOOD: 'Flood',
  TROPICAL_CYCLONE: 'Tropical cyclone',
  VOLCANO: 'Volcano',
  DROUGHT: 'Drought',
  WEATHER_ALERT: 'Weather alert',
  TSUNAMI: 'Tsunami',
  OTHER: 'Other',
};

export const LIFECYCLE_LABEL: Readonly<Record<LifecycleStatus, string>> = {
  ACTIVE: 'Active',
  UPDATED: 'Updated',
  ENDED: 'Ended',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  DELETED: 'Withdrawn by the provider',
  MISSING_FROM_SOURCE: 'No longer listed by the provider',
};

export const WINDOW_LABEL: Readonly<Record<ChangeWindow, string>> = {
  '6h': '6 h',
  '24h': '24 h',
  '7d': '7 d',
  since: 'Since last visit',
};

/** "14:06" local wall-clock time of a place, at `now`. */
export function localTime(now: string, timeZone: string): string {
  return formatClock(now, timeZone);
}
