/**
 * `describeRevision` — the sentence and the changed fields for one version of a record.
 *
 * Every expected sentence is written out, because the sentence *is* the product here: a timeline
 * that said "revised the magnitude" when the depth moved would be a false statement about a
 * provider, in a view that exists to make providers auditable.
 */

import { describe, expect, it } from 'vitest';

import { isLexiconClean } from './lexicon.ts';
import { EPICENTRE_MOVE_THRESHOLD_M, describeRevision, type VersionValues } from './timeline.ts';

const BASE: VersionValues = {
  observedAt: new Date('2026-09-21T11:40:00.000Z'),
  lifecycleStatus: 'ACTIVE',
  magnitude: 5.1,
  magnitudeType: 'mb',
  depthKm: 10,
  lat: 31.1,
  lon: -8.4,
  severity: null,
  providerStatus: 'automatic',
};

describe('describeRevision', () => {
  it('describes the first version as a first report, with its magnitude', () => {
    expect(describeRevision('USGS', null, BASE)).toStrictEqual({
      summary: 'USGS first reported it as M5.1.',
      changedFields: [],
      changes: [],
    });
  });

  it('describes a first report without a magnitude plainly', () => {
    expect(describeRevision('GDACS', null, { ...BASE, magnitude: null }).summary).toBe(
      'GDACS first reported it.',
    );
  });

  it('names a magnitude revision with both values', () => {
    const described = describeRevision('USGS', BASE, { ...BASE, magnitude: 5.3 });
    expect(described.summary).toBe('USGS revised the magnitude from M5.1 to M5.3.');
    expect(described.changedFields).toStrictEqual(['magnitude']);
    expect(described.changes).toStrictEqual([
      {
        code: 'MAGNITUDE',
        label: 'Magnitude',
        before: { kind: 'number', value: 5.1, unit: null, decimals: 1 },
        after: { kind: 'number', value: 5.3, unit: null, decimals: 1 },
      },
    ]);
  });

  it('names a depth revision in kilometres', () => {
    const described = describeRevision('EMSC', BASE, { ...BASE, depthKm: 25 });
    expect(described.summary).toBe('EMSC revised the depth from 10 km to 25 km.');
    expect(described.changedFields).toStrictEqual(['depthKm']);
  });

  it('joins several changes into one sentence, in a fixed order', () => {
    const described = describeRevision('USGS', BASE, {
      ...BASE,
      magnitude: 5.4,
      depthKm: 12,
      providerStatus: 'reviewed',
    });
    expect(described.summary).toBe(
      'USGS revised the magnitude from M5.1 to M5.4, revised the depth from 10 km to 12 km and marked it reviewed.',
    );
    expect(described.changedFields).toStrictEqual(['magnitude', 'depthKm', 'providerStatus']);
  });

  it('reports an epicentre move by its distance, and ignores relocation noise', () => {
    // 0.1° of latitude is about 11 km.
    const moved = describeRevision('USGS', BASE, { ...BASE, lat: 31.2 });
    expect(moved.summary).toBe('USGS moved the location by 11 km.');
    expect(moved.changes[0]).toStrictEqual({
      code: 'EPICENTRE_MOVED',
      label: 'Location moved by',
      before: null,
      after: { kind: 'number', value: 11, unit: 'km', decimals: 0 },
    });

    // About 111 m: below the threshold, so not a move worth telling a reader about.
    const jitter = describeRevision('USGS', BASE, { ...BASE, lat: 31.101 });
    expect(jitter.changedFields).toStrictEqual([]);
    expect(EPICENTRE_MOVE_THRESHOLD_M).toBe(500);
  });

  it('states a short move with one decimal', () => {
    // 0.01° of latitude is about 1.1 km.
    expect(describeRevision('USGS', BASE, { ...BASE, lat: 31.11 }).summary).toBe(
      'USGS moved the location by 1.1 km.',
    );
  });

  it('describes a withdrawal as a withdrawal, not a status code', () => {
    expect(describeRevision('USGS', BASE, { ...BASE, lifecycleStatus: 'DELETED' }).summary).toBe(
      'USGS withdrew the record.',
    );
    expect(
      describeRevision('EMSC', BASE, { ...BASE, lifecycleStatus: 'MISSING_FROM_SOURCE' }).summary,
    ).toBe('EMSC stopped listing the record.');
  });

  it('tells an update between live states from a reinstatement', () => {
    expect(describeRevision('USGS', BASE, { ...BASE, lifecycleStatus: 'UPDATED' }).summary).toBe(
      'USGS marked it updated.',
    );
    expect(describeRevision('GDACS', { ...BASE, lifecycleStatus: 'ENDED' }, BASE).summary).toBe(
      'GDACS marked it current again.',
    );
  });

  it('names an alert-level change on the provider’s own scale', () => {
    const green = { scheme: 'GDACS_ALERT' as const, value: 'Green' };
    const orange = { scheme: 'GDACS_ALERT' as const, value: 'Orange' };
    expect(
      describeRevision('GDACS', { ...BASE, severity: green }, { ...BASE, severity: orange })
        .summary,
    ).toBe('GDACS changed its alert level from Green to Orange.');
    expect(describeRevision('GDACS', BASE, { ...BASE, severity: green }).summary).toBe(
      'GDACS issued an alert level of Green.',
    );
  });

  it('says so when a version changed nothing GeoNerva shows', () => {
    expect(describeRevision('USGS', BASE, { ...BASE }).summary).toBe(
      'USGS updated its record without changing the values GeoNerva shows.',
    );
  });

  it('reports a withdrawn magnitude as withdrawn, never as zero', () => {
    const described = describeRevision('USGS', BASE, { ...BASE, magnitude: null });
    expect(described.summary).toBe('USGS withdrew the magnitude.');
    expect(described.changes[0]?.after).toBeNull();
  });

  it('never produces language the lexicon forbids', () => {
    const variants: VersionValues[] = [
      { ...BASE, lifecycleStatus: 'ENDED' },
      { ...BASE, lifecycleStatus: 'CANCELLED' },
      { ...BASE, lifecycleStatus: 'EXPIRED' },
      { ...BASE, magnitude: 7.9, depthKm: null, lat: 35, providerStatus: null },
    ];
    for (const variant of variants) {
      expect(isLexiconClean(describeRevision('USGS', BASE, variant).summary)).toBe(true);
    }
  });
});
