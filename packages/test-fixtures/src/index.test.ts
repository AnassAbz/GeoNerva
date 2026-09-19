import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  FIXTURE_SOURCES,
  fixturePath,
  readFixtureBytes,
  readFixtureJson,
  readManifest,
} from './index.ts';

describe('fixture loading', () => {
  it('exposes a manifest for every source', () => {
    for (const source of FIXTURE_SOURCES) {
      expect(readManifest(source).size, `${source} manifest`).toBeGreaterThan(0);
    }
  });

  it('reads bytes that match the recorded hash and size', () => {
    for (const source of FIXTURE_SOURCES) {
      for (const [file, entry] of readManifest(source)) {
        const bytes = readFixtureBytes(source, file);
        expect(createHash('sha256').update(bytes).digest('hex'), `${source}/${file}`).toBe(
          entry.sha256,
        );
        if (entry.bytes !== undefined) expect(bytes.byteLength).toBe(entry.bytes);
      }
    }
  });

  it('parses JSON fixtures and resolves paths', () => {
    const feed = readFixtureJson('usgs', 'all_day.geojson') as {
      type: string;
      features: unknown[];
    };
    expect(feed.type).toBe('FeatureCollection');
    expect(feed.features.length).toBeGreaterThan(0);
    // Path separators differ by platform.
    expect(fixturePath('usgs', 'all_day.geojson').replaceAll('\\', '/')).toMatch(
      /sources\/usgs\/all_day\.geojson$/,
    );
  });
});
