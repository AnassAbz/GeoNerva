/**
 * The FIRMS CSV parser (DATA_SOURCES §3.4).
 *
 * FIRMS is the one source whose output is not JSON and the one whose volume is a design
 * constraint rather than a detail: ≈ 128,000 rows and ≈ 10 MB per sensor per file, ≈ 230,000
 * detections a day across the two sensors GeoNerva ingests.
 *
 * Three consequences, all of them visible in the shape of this file:
 *
 *  1. **Header-driven, never positional.** The columns are read by name from the first line, so a
 *     provider that inserts a column — `type` appeared in one captured drift case — does not
 *     shift every value one place to the left and store a brightness as a scan angle. A *renamed*
 *     column we depend on (`frp` → `FRP_MW`, also captured) is drift and fails the batch, because
 *     silently losing fire radiative power on every detection is worse than a loud stop.
 *  2. **One pass, no intermediate array of strings.** The body is walked once, line by line, and
 *     each line becomes a detection or a reject. Splitting 10 MB into 128,000 arrays of 13
 *     strings first is a lot of garbage for nothing.
 *  3. **A detection has no id, so identity is derived.** FIRMS publishes no stable identifier;
 *     the key is `(product, acquired_at, round(lat, 4), round(lon, 4))` (ADR-011), which is what
 *     makes an overlapping `DAY_RANGE=2` poll a no-op. The rounding therefore has to happen here,
 *     exactly as the database does it, or two polls of the same pixel become two rows.
 */

import type { ConfidenceClass, RejectReasonCode } from '@geonerva/domain';

import type { RejectedRecord } from '../contract.ts';

/** Every column the parser reads. A missing one of these is drift, not a per-row problem. */
export const FIRMS_REQUIRED_COLUMNS = [
  'latitude',
  'longitude',
  'acq_date',
  'acq_time',
  'confidence',
  'version',
  'frp',
] as const;

/** Read when present, absent without complaint. MODIS lacks `bright_ti4`/`bright_ti5`. */
const OPTIONAL_COLUMNS = ['bright_ti4', 'bright_ti5', 'scan', 'track', 'daynight', 'satellite'];

/** One detection, in GeoNerva's vocabulary, ready for `fire_detections`. */
export interface FirmsDetection {
  readonly acquiredAt: Date;
  /** Rounded to 4 decimals, the precision the identity key uses. */
  readonly lat: number;
  readonly lon: number;
  readonly confidenceClass: ConfidenceClass | null;
  /** The provider's own word, kept whatever it was. */
  readonly confidenceRaw: string | null;
  readonly frp: number | null;
  readonly brightTi4: number | null;
  readonly brightTi5: number | null;
  readonly scan: number | null;
  readonly track: number | null;
  readonly daynight: 'D' | 'N' | null;
  /** `2.0NRT`, and whatever URT or RT suffix a keyed request may return. Stored verbatim. */
  readonly providerVersion: string | null;
}

export type FirmsParseResult =
  | {
      readonly verdict: 'OK';
      readonly detections: readonly FirmsDetection[];
      readonly rejects: readonly RejectedRecord[];
      /**
       * Detections whose `frp` was negative and is therefore stored as absent.
       *
       * Counted rather than silent. One row in 121,293 on 2026-09-20 — a single NOAA-21 pixel at
       * `frp = -0.1` — and the count is reported so that "one in a hundred thousand" turning into
       * "one in ten" is something an operator sees rather than something nobody ever learns.
       */
      readonly frpDropped: number;
    }
  | {
      readonly verdict: 'REJECTED';
      readonly errorClass: 'SCHEMA_DRIFT' | 'EMPTY_SUSPICIOUS';
      readonly detail: string;
      readonly rejects: readonly RejectedRecord[];
    };

/**
 * VIIRS confidence is categorical; MODIS is a 0–100 number.
 *
 * Only the categorical sensors are ingested (ADR-009), precisely so that one column does not hold
 * two incompatible scales — but the mapping is written to *refuse* a numeric value rather than
 * coerce it, so that the day someone adds MODIS the batch says so instead of silently turning
 * "confidence 47" into `NOMINAL`.
 */
export function confidenceClassOf(raw: string): ConfidenceClass | null {
  switch (raw.trim().toLowerCase()) {
    case 'l':
    case 'low':
      return 'LOW';
    case 'n':
    case 'nominal':
      return 'NOMINAL';
    case 'h':
    case 'high':
      return 'HIGH';
    default:
      return null;
  }
}

/**
 * `acq_date` + `acq_time` → an instant, in UTC.
 *
 * `acq_time` is `HHMM` **and is not zero-padded in every file** — `0013` appears padded in the
 * captured global files, but a bare `13` for 00:13 is the shape this format invites, so it is
 * parsed by value rather than by slicing fixed offsets. Slicing `"13"` would give hour 13.
 */
export function firmsInstant(acqDate: string, acqTime: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acqDate.trim())) return null;
  const digits = acqTime.trim();
  if (!/^\d{1,4}$/.test(digits)) return null;
  const value = Number(digits);
  const hours = Math.floor(value / 100);
  const minutes = value % 100;
  if (hours > 23 || minutes > 59) return null;
  const parsed = new Date(
    `${acqDate.trim()}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`,
  );
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

/**
 * Rounds a coordinate to the four decimals the identity key uses.
 *
 * Must match what the database stores in `lat_e4`/`lon_e4`, because those columns *are* the
 * identity of a detection (ADR-011) — FIRMS publishes no id. A half-up rounding here against a
 * truncation there would make every poll insert the same pixels again.
 */
export function roundCoordinate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function reject(reasonCode: RejectReasonCode, line: number, detail: string): RejectedRecord {
  return { reasonCode, excerpt: { line }, detail: detail.slice(0, 500) };
}

/** A CSV field reader that tolerates quoting, because a place name could arrive one day. */
function splitRow(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    // `noUncheckedIndexedAccess` types this as possibly undefined; the loop bound says otherwise.
    const char = line[index] ?? '';
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface FirmsParseOptions {
  /** Below this many rows the file is treated as broken rather than as a quiet day. */
  readonly emptyIsSuspicious: boolean;
  readonly maxRejectRatio: number;
}

export function parseFirmsCsv(body: Uint8Array, options: FirmsParseOptions): FirmsParseResult {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: 'the response body is not valid UTF-8',
      rejects: [],
    };
  }

  /*
   * An invalid MAP_KEY answers `Invalid MAP_KEY.` — a 12-byte body that is not CSV. It arrives
   * with a 4xx and is caught before this, but a body that is plainly not a CSV is checked here
   * too: this parser must be a total function of its input, because a stored payload is replayed
   * through it years later with no HTTP status in sight.
   */
  const newline = text.indexOf('\n');
  const headerLine = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, '');
  if (headerLine.trim().length === 0) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: 'the response has no header row',
      rejects: [],
    };
  }

  const header = splitRow(headerLine).map((name) => name.trim().toLowerCase());
  const index = new Map(header.map((name, position) => [name, position]));
  const missing = FIRMS_REQUIRED_COLUMNS.filter((name) => !index.has(name));
  if (missing.length > 0) {
    /*
     * Drift, and fatal to the batch.
     *
     * A renamed `frp` (`FRP_MW` in the captured case) would otherwise mean every detection is
     * stored with a null fire radiative power — the field that says how much energy the fire is
     * releasing — and nothing downstream could tell that from a genuinely quiet set of fires.
     */
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail: `the CSV header is missing ${missing.join(', ')}; the columns are ${header.slice(0, 20).join(',')}`,
      rejects: [],
    };
  }

  const at = (fields: readonly string[], name: string): string | undefined => {
    const position = index.get(name);
    return position === undefined ? undefined : fields[position];
  };

  const detections: FirmsDetection[] = [];
  const rejects: RejectedRecord[] = [];
  let frpDropped = 0;
  let lineNumber = 1;
  let cursor = newline === -1 ? text.length : newline + 1;

  while (cursor < text.length) {
    const next = text.indexOf('\n', cursor);
    const end = next === -1 ? text.length : next;
    const line = text.slice(cursor, end).replace(/\r$/, '');
    cursor = end + 1;
    lineNumber += 1;
    if (line.trim().length === 0) continue;

    const fields = splitRow(line);
    if (fields.length !== header.length) {
      rejects.push(
        reject(
          'SCHEMA_INVALID',
          lineNumber,
          `expected ${header.length} fields, found ${fields.length}`,
        ),
      );
      continue;
    }

    const lat = numberOrNull(at(fields, 'latitude'));
    const lon = numberOrNull(at(fields, 'longitude'));
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      rejects.push(
        reject('COORDINATES_INVALID', lineNumber, `lat=${String(lat)} lon=${String(lon)}`),
      );
      continue;
    }

    const acquiredAt = firmsInstant(at(fields, 'acq_date') ?? '', at(fields, 'acq_time') ?? '');
    if (acquiredAt === null) {
      rejects.push(
        reject(
          'MISSING_OBSERVED_AT',
          lineNumber,
          `acq_date=${at(fields, 'acq_date') ?? ''} acq_time=${at(fields, 'acq_time') ?? ''}`,
        ),
      );
      continue;
    }

    const confidenceRaw = at(fields, 'confidence')?.trim() ?? '';
    const confidenceClass = confidenceClassOf(confidenceRaw);
    if (confidenceClass === null && confidenceRaw.length > 0) {
      /*
       * A confidence this code does not recognise is a reject, never a guess.
       *
       * The value that would arrive here is a MODIS 0–100 number, and mapping it onto a
       * categorical class would put two incompatible scales in one column — the exact thing
       * ADR-009 excludes MODIS to avoid. The raw value is kept on every row that *is* understood,
       * so the provider's own word is never lost either way.
       */
      rejects.push(
        reject('SCHEMA_INVALID', lineNumber, `confidence ${confidenceRaw} is not low/nominal/high`),
      );
      continue;
    }

    /*
     * A negative fire radiative power is not a measurement, and it is not a reason to lose a
     * detection either.
     *
     * VIIRS FRP is retrieved by subtracting a modelled background, so a pixel near the noise
     * floor can come out fractionally below zero. The row is still a real detection — the one
     * observed case carried `confidence: nominal` and a 352 K brightness — but radiative power
     * cannot be negative, and `fire_detections.frp` has a `>= 0` CHECK that says so.
     *
     * Before this, that single row out of 121,293 failed the whole NOAA-21 batch. Relaxing the
     * CHECK would spread a physically impossible number through everything that ever sums FRP;
     * rejecting the row would lose a real fire to one bad field. Absent is what "no usable
     * measurement" means, and it is counted so the rate stays visible.
     */
    const rawFrp = numberOrNull(at(fields, 'frp'));
    let frp = rawFrp;
    if (rawFrp !== null && rawFrp < 0) {
      frp = null;
      frpDropped += 1;
    }

    const daynightRaw = at(fields, 'daynight')?.trim().toUpperCase();
    detections.push({
      acquiredAt,
      lat: roundCoordinate(lat),
      lon: roundCoordinate(lon),
      confidenceClass,
      confidenceRaw: confidenceRaw.length === 0 ? null : confidenceRaw,
      frp,
      brightTi4: numberOrNull(at(fields, 'bright_ti4')),
      brightTi5: numberOrNull(at(fields, 'bright_ti5')),
      scan: numberOrNull(at(fields, 'scan')),
      track: numberOrNull(at(fields, 'track')),
      daynight: daynightRaw === 'D' || daynightRaw === 'N' ? daynightRaw : null,
      providerVersion: at(fields, 'version')?.trim() ?? null,
    });
  }

  const total = detections.length + rejects.length;
  if (total === 0) {
    if (!options.emptyIsSuspicious) return { verdict: 'OK', detections, rejects, frpDropped };
    /*
     * Zero detections worldwide.
     *
     * There is no hour in which nothing on Earth is burning: the captured global files hold
     * ≈ 128,000 rows. An empty one means the file was not written, the request was refused, or
     * something upstream broke — and reporting it as "no fires" would be the single most
     * misleading thing this system could say.
     */
    return {
      verdict: 'REJECTED',
      errorClass: 'EMPTY_SUSPICIOUS',
      detail: 'the global detection file held no rows, and nowhere on Earth is never burning',
      rejects,
    };
  }

  const ratio = rejects.length / total;
  if (ratio > options.maxRejectRatio) {
    return {
      verdict: 'REJECTED',
      errorClass: 'SCHEMA_DRIFT',
      detail:
        `${rejects.length} of ${total} rows failed validation ` +
        `(${(ratio * 100).toFixed(1)} %), above the ${(options.maxRejectRatio * 100).toFixed(0)} % drift threshold`,
      // Bounded: a drifted 128,000-row file would otherwise try to carry 128,000 reject rows
      // into a failure path whose whole job is to stay writable.
      rejects: rejects.slice(0, 100),
    };
  }
  return { verdict: 'OK', detections, rejects: rejects.slice(0, 1_000), frpDropped };
}

export { OPTIONAL_COLUMNS };
