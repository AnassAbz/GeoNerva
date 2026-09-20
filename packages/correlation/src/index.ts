/**
 * @geonerva/correlation — Deterministic, versioned, explainable event correlation.
 *
 * Pure: no clock, no IO, no database, and no model. Candidates arrive as arguments — the indexable
 * narrowing is the database's job — and every decision returns the reasons and the scored
 * alternatives that produced it, because a merge that cannot be explained cannot be trusted.
 *
 * See docs/ARCHITECTURE.md §6 for the algorithm and §3 for this package's allowed dependencies.
 */

export {
  CANDIDATE_WINDOW,
  CONFIDENCE_BOUNDS,
  CROSS_FAMILY_MAGNITUDE_WEIGHT,
  DECISION,
  EARTHQUAKE_ALGORITHM_VERSION,
  HYSTERESIS_MISFIT,
  IDENTITY_REF_CONFIDENCE,
  IDENTITY_REF_PENDING_HOURS,
  MAGNITUDE_FAMILIES,
  MAGNITUDE_VETO,
  MISFIT_SCALES,
  SOURCE_AGENCY_CODES,
} from './earthquake.config.ts';

export {
  MisfitError,
  computeMisfit,
  isRepublication,
  magnitudeFamily,
  magnitudeVeto,
  sameMagnitudeFamily,
  withinCandidateWindow,
} from './misfit.ts';
export type { MisfitTerms, Solution, VetoVerdict } from './misfit.ts';

export {
  confidenceFor,
  decideIdentityRef,
  decideSpatiotemporal,
  revisionKeepsLink,
} from './decide.ts';
export type {
  Candidate,
  CorrelationReason,
  CorrelationVerdict,
  Decision,
  LinkRelation,
  MatchKind,
  ScoredCandidate,
} from './decide.ts';

export { calibrate, scorePair, vetoStatistics } from './calibration.ts';
export type { CalibrationResult, LabelledPair, LabelledSet, PairOutcome } from './calibration.ts';
