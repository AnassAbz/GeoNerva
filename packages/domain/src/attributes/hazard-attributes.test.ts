import { describe, expect, it } from 'vitest';

import {
  HAZARD_ATTRIBUTE_SCHEMAS,
  MAX_ATTRIBUTES_BYTES,
  earthquakeAttributesSchema,
  floodAttributesSchema,
  isAttributesWithinSizeLimit,
  parseHazardAttributes,
  weatherAlertAttributesSchema,
} from './hazard-attributes.ts';
import { HAZARD_TYPES } from '../enums.ts';

describe('hazard attribute schemas', () => {
  it('covers every hazard type exactly once', () => {
    expect(Object.keys(HAZARD_ATTRIBUTE_SCHEMAS).sort()).toStrictEqual([...HAZARD_TYPES].sort());
  });

  it('accepts an empty object for every hazard type that has no required field', () => {
    for (const hazardType of HAZARD_TYPES) {
      const result = parseHazardAttributes(hazardType, {});
      // FLOOD is the one type with a required field, because centroid-only matters (§9.3).
      expect(result.ok).toBe(hazardType !== 'FLOOD');
    }
  });

  it('rejects unknown keys, because they mean drift or a normalization bug', () => {
    const result = parseHazardAttributes('EARTHQUAKE', { magnitude: 5.3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(' ')).toMatch(/magnitude/);
  });

  it('rejects a non-object', () => {
    for (const value of [null, 'x', 42, []]) {
      expect(parseHazardAttributes('EARTHQUAKE', value).ok).toBe(false);
    }
  });

  it('reports the failing path, so a reject row can explain itself', () => {
    const result = parseHazardAttributes('EARTHQUAKE', { azimuthal_gap_deg: 400 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]).toMatch(/^azimuthal_gap_deg: /);
  });

  describe('earthquake', () => {
    it('accepts a full USGS-shaped record', () => {
      const parsed = earthquakeAttributesSchema.parse({
        magnitude_source: 'us',
        felt_reports: 132,
        community_intensity_cdi: 4.6,
        instrumental_intensity_mmi: 5.1,
        tsunami_flag: true,
        review_status: 'reviewed',
        significance: 456,
        station_count: 88,
        min_station_distance_km: 12.4,
        azimuthal_gap_deg: 36,
        rms_s: 0.86,
        identity_refs: ['us7000tikb', 'pr2026123'],
        region_name: '12 km SSW of Marrakech, Morocco',
        event_type: 'earthquake',
      });
      expect(parsed.identity_refs).toStrictEqual(['us7000tikb', 'pr2026123']);
    });

    it('rejects an out-of-scale intensity', () => {
      expect(earthquakeAttributesSchema.safeParse({ instrumental_intensity_mmi: 13 }).success).toBe(
        false,
      );
    });

    it('rejects an unknown review status rather than guessing', () => {
      expect(earthquakeAttributesSchema.safeParse({ review_status: 'preliminary' }).success).toBe(
        false,
      );
    });
  });

  describe('flood', () => {
    it('requires has_area_geometry, because centroid-only changes what may be claimed', () => {
      expect(floodAttributesSchema.safeParse({}).success).toBe(false);
      expect(floodAttributesSchema.safeParse({ has_area_geometry: false }).success).toBe(true);
    });

    it('carries GDACS episode context', () => {
      const parsed = floodAttributesSchema.parse({
        has_area_geometry: true,
        episode_id: '3',
        alert_score: 2,
        countries: ['Morocco'],
        country_iso3: ['MAR'],
        is_current: true,
        source_agency: 'GloFAS',
      });
      expect(parsed.episode_id).toBe('3');
    });

    it('rejects a lowercase ISO-3 code', () => {
      expect(
        floodAttributesSchema.safeParse({ has_area_geometry: true, country_iso3: ['mar'] }).success,
      ).toBe(false);
    });
  });

  describe('weather alert', () => {
    it('keeps alert text verbatim and unabridged', () => {
      const description = 'Snowfall warning in effect. '.repeat(100);
      const parsed = weatherAlertAttributesSchema.parse({
        description_verbatim: description,
        alert_class: 'warning',
        message_type: 'Alert',
        alert_thread_id: 'ca.weather.alert.thread.42',
      });
      expect(parsed.description_verbatim).toBe(description);
    });

    it('rejects an unknown CAP urgency', () => {
      expect(weatherAlertAttributesSchema.safeParse({ urgency: 'Urgent' }).success).toBe(false);
    });
  });

  describe('size limit', () => {
    it('accepts a normal record', () => {
      expect(isAttributesWithinSizeLimit({ region_name: 'Marrakech' })).toBe(true);
    });

    it('rejects an oversized record', () => {
      expect(isAttributesWithinSizeLimit({ region_name: 'x'.repeat(MAX_ATTRIBUTES_BYTES) })).toBe(
        false,
      );
    });

    it('measures bytes, not characters', () => {
      const emoji = '🔥'.repeat(MAX_ATTRIBUTES_BYTES / 4);
      expect(isAttributesWithinSizeLimit({ region_name: emoji })).toBe(false);
    });
  });
});
