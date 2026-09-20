/**
 * FIRMS: the CSV parser, and the credential boundary.
 *
 * The credential tests are the ones that matter most, and they are deliberately *negative*: they
 * assert that a 32-character key does not appear in things that get logged, stored or thrown.
 * FIRMS is the only source in v1 with a credential and it puts it in the URL **path**, so the
 * ordinary reflex of logging a URL on failure would put a working key into a log aggregator, and
 * nothing downstream would ever notice.
 */

import { describe, expect, it } from 'vitest';

import { readFixtureBytes } from '@geonerva/test-fixtures';

import {
  FIRMS_MAX_DAY_RANGE,
  firmsAreaUrl,
  firmsEndpoint,
  firmsKeylessUrl,
  isInvalidKeyResponse,
  isValidMapKey,
  redactFirmsUrl,
} from './api.ts';
import { firmsDescriptor, parseFirms } from './adapter.ts';
import { confidenceClassOf, firmsInstant, parseFirmsCsv, roundCoordinate } from './parse.ts';

/** A syntactically valid key, so the tests exercise the real path. Not a real credential. */
const KEY = 'abcdef0123456789abcdef0123456789';

function csv(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(lines.join('\n'));
}

const HEADER =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,bright_ti5,frp,daynight';
const ROW = '-13.66386,17.06811,296.27,0.38,0.36,2026-09-18,0013,N20,nominal,2.0NRT,285.89,0.35,N';

describe('the credential boundary', () => {
  it('never lets the key into the string anything observable uses', () => {
    /*
     * The whole point. `firmsAreaUrl` returns a URL containing the key, and it is handed
     * straight to the HTTP client and nowhere else; `firmsEndpoint` is what the log line, the
     * run row and the error carry, and it has a fixed placeholder where the key would be.
     */
    expect(firmsAreaUrl({ sensor: 'VIIRS_NOAA20_NRT', mapKey: KEY, dayRange: 2 })).toContain(KEY);

    const endpoint = firmsEndpoint('VIIRS_NOAA20_NRT', false);
    expect(endpoint).not.toContain(KEY);
    expect(endpoint).toContain('{MAP_KEY}');
    // Not even a prefix: a partial key is a slow leak, and 32 characters do not need many
    // samples to become guessable.
    expect(endpoint).not.toContain(KEY.slice(0, 4));
  });

  it('strips anything key-shaped out of text on its way to a log or a run row', () => {
    const leaked = `GET https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/VIIRS_NOAA20_NRT/world/2 failed`;
    const safe = redactFirmsUrl(leaked);
    expect(safe).not.toContain(KEY);
    expect(safe).toContain('{MAP_KEY}');
    // Ordinary words survive: the pattern is the key's own alphabet and exact length.
    expect(redactFirmsUrl('the request to firms failed after 3 attempts')).toBe(
      'the request to firms failed after 3 attempts',
    );
  });

  it('refuses a key that is not a key, without quoting it', () => {
    /*
     * A key with a trailing newline from a copied secret would otherwise be sent to NASA, and the
     * error that came back would be something this code then has to be careful never to quote.
     * Better never to send it — and the refusal says nothing about the value, not its length and
     * not a prefix.
     */
    expect(isValidMapKey(KEY)).toBe(true);
    expect(isValidMapKey(`${KEY}\n`)).toBe(false);
    expect(isValidMapKey(KEY.toUpperCase())).toBe(false);
    expect(isValidMapKey(KEY.slice(0, 31))).toBe(false);

    let message = '';
    try {
      firmsAreaUrl({ sensor: 'VIIRS_NOAA20_NRT', mapKey: 'nope', dayRange: 2 });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('not a valid key');
    expect(message).not.toContain('nope');
  });

  it('needs no credential at all in keyless mode', () => {
    const url = firmsKeylessUrl('VIIRS_NOAA20_NRT');
    expect(url).toContain('J1_VIIRS_C2_Global_24h.csv');
    expect(url).not.toMatch(/[a-z0-9]{32}/);
    expect(firmsKeylessUrl('VIIRS_NOAA21_NRT')).toContain('J2_VIIRS_C2_Global_24h.csv');
  });

  it('recognises every shape an unusable key comes back as', () => {
    /*
     * P0 captured three different statuses for the same condition: the Area API answers 400,
     * `data_availability` 401 and `mapkey_status` 403. A client that read 400 as "our bad
     * request" and 401 as "retry after refresh" would be wrong about both — all three mean the
     * credential cannot be used and no retry will change that.
     */
    const body = readFixtureBytes('firms', 'area-invalid-mapkey.txt');
    expect(isInvalidKeyResponse(400, body)).toBe(true);
    expect(isInvalidKeyResponse(401, body)).toBe(true);
    expect(isInvalidKeyResponse(403, readFixtureBytes('firms', 'mapkey-status-invalid.html'))).toBe(
      true,
    );
    // A real CSV with a 200 is not a credential failure.
    expect(isInvalidKeyResponse(200, csv([HEADER, ROW]))).toBe(false);
  });

  it('refuses a DAY_RANGE outside the documented range', () => {
    // 1–5, not 1–10 whatever older material says.
    expect(() =>
      firmsAreaUrl({ sensor: 'VIIRS_NOAA20_NRT', mapKey: KEY, dayRange: FIRMS_MAX_DAY_RANGE + 1 }),
    ).toThrow(/DAY_RANGE/);
    expect(() => firmsAreaUrl({ sensor: 'VIIRS_NOAA20_NRT', mapKey: KEY, dayRange: 0 })).toThrow(
      /DAY_RANGE/,
    );
  });
});

describe('timestamps and identity', () => {
  it('reads acq_date + acq_time as UTC', () => {
    expect(firmsInstant('2026-09-18', '0013')?.toISOString()).toBe('2026-09-18T00:13:00.000Z');
    expect(firmsInstant('2026-09-18', '1834')?.toISOString()).toBe('2026-09-18T18:34:00.000Z');
  });

  it('reads an unpadded acq_time by value, not by slicing', () => {
    // `"13"` sliced at fixed offsets gives hour 13. Parsed by value it is 00:13, which is what
    // `HHMM` without zero-padding means.
    expect(firmsInstant('2026-09-18', '13')?.toISOString()).toBe('2026-09-18T00:13:00.000Z');
    expect(firmsInstant('2026-09-18', '2461')).toBeNull();
    expect(firmsInstant('18/09/2026', '0013')).toBeNull();
  });

  it('rounds coordinates the way the identity key does', () => {
    // FIRMS has no detection id: `(product, acquired_at, round(lat,4), round(lon,4))` *is* the
    // identity (ADR-011), so a rounding that disagrees with the column makes every poll reinsert.
    expect(roundCoordinate(-13.663861)).toBe(-13.6639);
    expect(roundCoordinate(17.06811)).toBe(17.0681);
  });

  it('maps VIIRS confidence and refuses a MODIS number', () => {
    expect(confidenceClassOf('nominal')).toBe('NOMINAL');
    expect(confidenceClassOf('h')).toBe('HIGH');
    // MODIS is numeric 0–100. Coercing it would put two incompatible scales in one column, which
    // is precisely why ADR-009 excludes MODIS.
    expect(confidenceClassOf('47')).toBeNull();
  });
});

describe('parsing', () => {
  const options = { emptyIsSuspicious: true, maxRejectRatio: 0.2 };

  it('reads a captured global slice', () => {
    const result = parseFirms(readFixtureBytes('firms', 'j1-24h-slice.csv'), 'VIIRS_NOAA20_NRT');
    if (result.verdict !== 'OK') throw new Error(`expected OK, got ${result.detail}`);
    expect(result.detections.length).toBeGreaterThan(100);
    expect(result.rejects).toHaveLength(0);
    expect(result.detections[0]?.providerVersion).toBe('2.0NRT');
    expect(result.detections[0]?.confidenceClass).toBe('NOMINAL');
  });

  it('tolerates a column appended at the end', () => {
    // The captured drift case adds `type` after `daynight`. Nothing shifts, so this only proves
    // that an unknown column is not itself treated as drift — see the next test for the real one.
    const result = parseFirms(
      readFixtureBytes('firms', 'drift-extra-column.csv'),
      'VIIRS_NOAA20_NRT',
    );
    if (result.verdict !== 'OK') throw new Error('an extra column is not drift');
    expect(result.detections[0]?.brightTi4).toBe(296.27);
    expect(result.detections[0]?.frp).toBe(0.35);
  });

  it('reads columns by name, so a column inserted in the middle shifts nothing', () => {
    /*
     * This is the test the captured fixture cannot be: appending `type` at the end leaves every
     * position unchanged, so a positional parser passes it. Written against the appended case
     * alone, this whole guard was **vacuous** — replacing the header lookup with a fixed column
     * order made no test fail.
     *
     * Inserting a column in the middle is what actually happens when a provider adds a field, and
     * a positional parser then stores `bright_ti5` as `frp` and `frp` as `daynight`: every value
     * still a plausible number, every fire radiative power silently wrong.
     */
    const header =
      'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,confidence,version,instrument,bright_ti5,frp,daynight';
    const row =
      '-13.66386,17.06811,296.27,0.38,0.36,2026-09-18,0013,N20,nominal,2.0NRT,VIIRS,285.89,0.35,N';
    const result = parseFirmsCsv(csv([header, ...Array.from({ length: 5 }, () => row)]), options);
    if (result.verdict !== 'OK') throw new Error('an inserted column is not drift');
    expect(result.detections[0]?.brightTi5).toBe(285.89);
    expect(result.detections[0]?.frp).toBe(0.35);
    expect(result.detections[0]?.daynight).toBe('N');
  });

  it('fails the batch when a column it depends on was renamed', () => {
    // `frp` → `FRP_MW`. Silently storing null fire radiative power on every detection would be
    // indistinguishable from a genuinely quiet set of fires.
    const result = parseFirms(
      readFixtureBytes('firms', 'drift-renamed-column.csv'),
      'VIIRS_NOAA20_NRT',
    );
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('SCHEMA_DRIFT');
    expect(result.detail).toMatch(/frp/);
  });

  it('fails the batch when a required column vanished', () => {
    const result = parseFirms(
      readFixtureBytes('firms', 'drift-missing-column.csv'),
      'VIIRS_NOAA20_NRT',
    );
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.detail).toMatch(/confidence/);
  });

  it('treats a header-only file as broken, not as a quiet planet', () => {
    /*
     * There is no hour in which nothing on Earth is burning — the captured global files hold
     * ≈ 128,000 rows. "No fires detected worldwide" would be the most misleading sentence this
     * system could produce.
     */
    const result = parseFirms(readFixtureBytes('firms', 'drift-empty.csv'), 'VIIRS_NOAA20_NRT');
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.errorClass).toBe('EMPTY_SUSPICIOUS');
  });

  it('fails the batch on an HTML page served with 200', () => {
    const result = parseFirms(readFixtureBytes('firms', 'drift-html-200.html'), 'VIIRS_NOAA20_NRT');
    expect(result.verdict).toBe('REJECTED');
  });

  it('rejects a bad row without losing the batch', () => {
    const rows = [HEADER, ...Array.from({ length: 20 }, () => ROW)];
    rows.push('999,17.06811,296.27,0.38,0.36,2026-09-18,0013,N20,nominal,2.0NRT,285.89,0.35,N');
    const result = parseFirmsCsv(csv(rows), options);
    if (result.verdict !== 'OK') throw new Error('one bad row is not drift');
    expect(result.rejects).toHaveLength(1);
    expect(result.rejects[0]?.reasonCode).toBe('COORDINATES_INVALID');
  });

  it('spans midnight without losing the older day', () => {
    /*
     * The keyless "24 h" file is not 24 hours: P0 measured one holding acquisitions across two
     * `acq_date`s over about 42 hours. A parser that assumed a single day, or a persist path that
     * created one partition, would silently drop everything before midnight.
     */
    const result = parseFirms(
      readFixtureBytes('firms', 'j1-24h-midnight-span.csv'),
      'VIIRS_NOAA20_NRT',
    );
    if (result.verdict !== 'OK') throw new Error('the midnight-span capture must parse');
    const days = new Set(
      result.detections.map((detection) => detection.acquiredAt.toISOString().slice(0, 10)),
    );
    expect(days.size).toBeGreaterThan(1);
  });

  it('keeps a detection whose frp is negative, and drops only the number', () => {
    /*
     * A real finding, from a live run: one NOAA-21 row in 121,293 carried `frp = -0.1`, and
     * `fire_detections.frp` has a `>= 0` CHECK, so that single row failed the whole batch after
     * 33,000 rows were already in.
     *
     * VIIRS FRP is retrieved by subtracting a modelled background, so a pixel near the noise
     * floor can land fractionally below zero. The row is a real detection — the observed one had
     * `confidence: nominal` and a 352 K brightness — but radiative power cannot be negative.
     * Relaxing the CHECK would spread an impossible number through everything that sums FRP;
     * rejecting the row would lose a fire to one bad field.
     */
    const negative =
      '-7.24988,29.43557,352.53,0.38,0.36,2026-09-19,1134,N21,nominal,2.0NRT,285.89,-0.1,D';
    const result = parseFirmsCsv(
      csv([HEADER, ...Array.from({ length: 20 }, () => ROW), negative]),
      options,
    );
    if (result.verdict !== 'OK') throw new Error('one impossible number is not a dead batch');
    expect(result.detections).toHaveLength(21);
    expect(result.rejects).toHaveLength(0);

    const affected = result.detections.find((detection) => detection.brightTi4 === 352.53);
    expect(affected?.frp).toBeNull();
    // Counted, so a rate that moves is visible rather than being learned about years later.
    expect(result.frpDropped).toBe(1);
    // A zero FRP is a real reading and must survive untouched.
    expect(
      parseFirmsCsv(csv([HEADER, ROW.replace(',0.35,', ',0,')]), {
        ...options,
        emptyIsSuspicious: false,
      }),
    ).toMatchObject({ frpDropped: 0 });
  });

  it('is idempotent: the same bytes give the same detections', () => {
    const body = readFixtureBytes('firms', 'j1-24h-slice.csv');
    const first = parseFirms(body, 'VIIRS_NOAA20_NRT');
    const second = parseFirms(body, 'VIIRS_NOAA20_NRT');
    if (first.verdict !== 'OK' || second.verdict !== 'OK') throw new Error('should parse');
    const key = (result: typeof first) =>
      result.detections.map((d) => `${d.acquiredAt.toISOString()}|${d.lat}|${d.lon}`);
    expect(key(second)).toStrictEqual(key(first));
  });
});

describe('the descriptor', () => {
  it('matches the seeded product and allows only the FIRMS host', () => {
    const descriptor = firmsDescriptor('VIIRS_NOAA20_NRT');
    expect(descriptor.hazardType).toBe('THERMAL_ACTIVITY');
    expect(descriptor.allowedHosts).toStrictEqual(['firms.modaps.eosdis.nasa.gov']);
    expect([...descriptor.capabilities].sort()).toStrictEqual([
      'HISTORICAL_EVENTS',
      'POINT_DETECTIONS',
      'REALTIME_EVENTS',
    ]);
    // 10.7 MB measured for one global file; the cap has to clear it with room to grow.
    expect(descriptor.maxBytes).toBeGreaterThan(11 * 1024 * 1024);
  });
});
