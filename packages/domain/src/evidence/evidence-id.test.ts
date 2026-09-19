import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CONTENT_ADDRESSED_EVIDENCE_KINDS,
  EVIDENCE_KINDS,
  EvidenceIdError,
  PRIMARY_EVIDENCE_KINDS,
  evidenceId,
  evidenceIdKind,
  evidenceIdSchema,
  evidenceRefSchema,
  formatEvidenceId,
  isContentAddressedEvidenceKind,
  isEvidenceId,
  isPrimaryEvidenceKind,
  parseEvidenceId,
  tryParseEvidenceId,
  type EvidenceRef,
} from './evidence-id.ts';

const UUID = '0b6c5f1e-9a2d-4c37-8f11-6e2a9c0d4b77';
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A generator over every legal reference shape, used for the round-trip property. */
const databaseIdArb = fc
  .bigInt({ min: 1n, max: 9_223_372_036_854_775_807n })
  .map((value) => value.toString());

const HEX_DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'];
const sha256Arb = fc
  .array(fc.constantFrom(...HEX_DIGITS), { minLength: 64, maxLength: 64 })
  .map((digits) => digits.join(''));

const refArb: fc.Arbitrary<EvidenceRef> = fc.oneof(
  databaseIdArb.map((versionId): EvidenceRef => ({ kind: 'OBS', versionId })),
  databaseIdArb.map((clusterVersionId): EvidenceRef => ({ kind: 'FCV', clusterVersionId })),
  fc
    .tuple(databaseIdArb, fc.integer({ min: 0, max: 9_999_999_999 }))
    .map(([clusterVersionId, count]): EvidenceRef => ({ kind: 'FDS', clusterVersionId, count })),
  fc.uuid({ version: 4 }).map((runId): EvidenceRef => ({ kind: 'RUN', runId })),
  databaseIdArb.map((linkId): EvidenceRef => ({ kind: 'COR', linkId })),
  sha256Arb.map((sha256): EvidenceRef => ({ kind: 'BAS', sha256 })),
  sha256Arb.map((sha256): EvidenceRef => ({ kind: 'REL', sha256 })),
  sha256Arb.map((sha256): EvidenceRef => ({ kind: 'CHG', sha256 })),
);

describe('evidence id codec', () => {
  it('formats each kind in its documented shape', () => {
    expect(evidenceId.observation('41')).toBe('EV:OBS:41');
    expect(evidenceId.fireClusterVersion('7')).toBe('EV:FCV:7');
    expect(evidenceId.detectionSet('7', 128)).toBe('EV:FDS:7:128');
    expect(evidenceId.ingestionRun(UUID)).toBe(`EV:RUN:${UUID}`);
    expect(evidenceId.correlation('99')).toBe('EV:COR:99');
    expect(evidenceId.baseline(SHA)).toBe(`EV:BAS:${SHA}`);
    expect(evidenceId.relevance(SHA)).toBe(`EV:REL:${SHA}`);
    expect(evidenceId.change(SHA)).toBe(`EV:CHG:${SHA}`);
  });

  it('round-trips every reference shape', () => {
    fc.assert(
      fc.property(refArb, (ref) => {
        const id = formatEvidenceId(ref);
        expect(parseEvidenceId(id)).toStrictEqual(ref);
        expect(formatEvidenceId(parseEvidenceId(id))).toBe(id);
      }),
      { numRuns: 500 },
    );
  });

  it('accepts the largest bigint identifier', () => {
    const id = evidenceId.observation('9223372036854775807');
    expect(parseEvidenceId(id)).toStrictEqual({
      kind: 'OBS',
      versionId: '9223372036854775807',
    });
  });

  it.each([
    ['empty', ''],
    ['no prefix', 'OBS:41'],
    ['lowercase prefix', 'ev:OBS:41'],
    ['lowercase kind', 'EV:obs:41'],
    ['unknown kind', 'EV:XXX:41'],
    ['missing body', 'EV:OBS:'],
    ['missing body separator', 'EV:OBS'],
    ['extra segment', 'EV:OBS:41:2'],
    ['leading zero', 'EV:OBS:041'],
    ['zero id', 'EV:OBS:0'],
    ['negative id', 'EV:OBS:-1'],
    ['non-numeric id', 'EV:OBS:4a'],
    ['id beyond bigint', 'EV:OBS:9223372036854775808'],
    ['id far beyond bigint', 'EV:OBS:99999999999999999999'],
    ['leading whitespace', ' EV:OBS:41'],
    ['trailing whitespace', 'EV:OBS:41 '],
    ['trailing newline', 'EV:OBS:41\n'],
    ['uppercase uuid', `EV:RUN:${UUID.toUpperCase()}`],
    ['braced uuid', `EV:RUN:{${UUID}}`],
    ['uuid without dashes', 'EV:RUN:0b6c5f1e9a2d4c378f116e2a9c0d4b77'],
    ['short sha', `EV:BAS:${SHA.slice(0, 63)}`],
    ['long sha', `EV:BAS:${SHA}0`],
    ['uppercase sha', `EV:BAS:${SHA.toUpperCase()}`],
    ['sha in an id slot', `EV:OBS:${SHA}`],
    ['fds without count', 'EV:FDS:7'],
    ['fds with leading-zero count', 'EV:FDS:7:007'],
    ['fds with negative count', 'EV:FDS:7:-1'],
    ['fds with three parts', 'EV:FDS:7:1:2'],
    ['sql injection attempt', 'EV:OBS:41; DROP TABLE geonerva.observation_versions--'],
    ['path traversal attempt', 'EV:OBS:../../etc/passwd'],
    ['unicode digits', 'EV:OBS:٤١'],
  ])('rejects %s', (_name, malformed) => {
    expect(tryParseEvidenceId(malformed)).toBeNull();
    expect(isEvidenceId(malformed)).toBe(false);
    expect(evidenceIdKind(malformed)).toBeNull();
    expect(() => parseEvidenceId(malformed)).toThrow(EvidenceIdError);
  });

  it('rejects an id longer than any legal evidence id without parsing it', () => {
    expect(isEvidenceId(`EV:OBS:${'1'.repeat(5_000)}`)).toBe(false);
  });

  it('refuses to format a malformed reference', () => {
    expect(() => formatEvidenceId({ kind: 'OBS', versionId: '0' })).toThrow(EvidenceIdError);
    expect(() => formatEvidenceId({ kind: 'RUN', runId: 'not-a-uuid' })).toThrow(EvidenceIdError);
    expect(() => formatEvidenceId({ kind: 'BAS', sha256: 'abc' })).toThrow(EvidenceIdError);
    expect(() => formatEvidenceId({ kind: 'FDS', clusterVersionId: '7', count: 1.5 })).toThrow(
      EvidenceIdError,
    );
    expect(() => formatEvidenceId({ kind: 'FDS', clusterVersionId: '7', count: -1 })).toThrow(
      EvidenceIdError,
    );
  });

  it('never leaks the offending input through the error message', () => {
    const secretish = 'EV:OBS:postgres://user:password@host/db';
    try {
      parseEvidenceId(secretish);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EvidenceIdError);
      expect((error as Error).message).not.toContain('password');
      expect((error as EvidenceIdError).input).toBe(secretish);
    }
  });

  it('classifies kinds as primary or content-addressed, and never both', () => {
    for (const kind of EVIDENCE_KINDS) {
      const primary = isPrimaryEvidenceKind(kind);
      const derived = isContentAddressedEvidenceKind(kind);
      expect(primary && derived).toBe(false);
    }
    expect([...PRIMARY_EVIDENCE_KINDS]).toStrictEqual(['OBS', 'FCV', 'RUN', 'COR']);
    expect([...CONTENT_ADDRESSED_EVIDENCE_KINDS]).toStrictEqual(['BAS', 'REL', 'CHG']);
    // FDS is neither: it is persisted through cluster membership, not as a resolvable row.
    expect(isPrimaryEvidenceKind('FDS')).toBe(false);
    expect(isContentAddressedEvidenceKind('FDS')).toBe(false);
  });

  it('exposes Zod schemas that validate and parse', () => {
    expect(evidenceIdSchema.safeParse('EV:OBS:41').success).toBe(true);
    expect(evidenceIdSchema.safeParse('EV:OBS:x').success).toBe(false);
    expect(evidenceRefSchema.parse('EV:COR:5')).toStrictEqual({ kind: 'COR', linkId: '5' });
  });
});
