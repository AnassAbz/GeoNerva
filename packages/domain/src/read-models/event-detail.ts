/**
 * `EventDetail` — the response of `GET /api/v1/events/{publicId}` (docs/ARCHITECTURE.md §13.1).
 *
 * This is where GeoNerva's central claim is cashed out: a canonical event is an **identity that
 * links provider records**, and its values are *projected* from the linked versions rather than
 * stored as truth (docs/DOMAIN_MODEL.md §4.8). The detail view therefore shows, side by side:
 *
 *  - what each source says (`observations`), including which agency contributed it;
 *  - how those statements agree or conflict (`agreement`), field by field;
 *  - how the record changed over time (`timeline`), version by version;
 *  - why GeoNerva believes these records describe one event (`correlation`), with its reasons;
 *  - and, only when the caller supplies a location, what it means for that place (`relevance`).
 *
 * A derived copy is never counted as corroboration: GDACS restating a USGS solution is
 * `DERIVED_COPY` and is excluded from `nIndependentSources` (ADR-006).
 */

import type {
  AgreementLevel,
  HazardFamily,
  HazardType,
  LifecycleStatus,
  LinkMatchKind,
  LinkRelation,
} from '../enums.ts';
import type { EvidenceId } from '../evidence/evidence-id.ts';
import type { ProviderSeverity } from '../value-objects/provider-severity.ts';
import type { IsoTimestamp } from '../value-objects/time.ts';
import type { SubjectRef } from '../value-objects/subject-ref.ts';
import type {
  Agreement,
  AsOfContext,
  Attribution,
  Fact,
  GeometryView,
  ReadModelSchemaVersion,
  Reason,
  RelevanceAssessment,
} from './common.ts';
import type { EvidenceItem } from './evidence-item.ts';

export interface EventDetail {
  readonly schemaVersion: ReadModelSchemaVersion;
  readonly publicId: string;
  readonly subjectRef: SubjectRef;
  readonly hazardType: HazardType;
  readonly family: HazardFamily;
  readonly asOfContext: AsOfContext;
  readonly createdAt: IsoTimestamp;

  /** The projected headline values at `asOf`, from the preferred source. */
  readonly headline: EventHeadline;
  /** One entry per linked source record, carrying that source's own values. */
  readonly observations: readonly EventObservationView[];
  readonly agreement: Agreement;
  /** Every version of every linked record, newest first. The audit trail. */
  readonly timeline: readonly EventTimelineEntry[];
  readonly correlation: CorrelationView;
  readonly geometries: readonly GeometryView[];

  /** Present only when the request supplied a location. */
  readonly relevance: RelevanceAssessment | null;
  readonly distanceKm: number | null;
  readonly hypocentralDistanceKm: number | null;

  /** When this event was merged into another, the survivor's public ID. Old IDs redirect. */
  readonly mergedIntoPublicId: string | null;
  readonly mergedAt: IsoTimestamp | null;
  /** Public IDs that now redirect here. */
  readonly supersededPublicIds: readonly string[];

  /** Related, never "the same": a GDACS WF next to a fire cluster, a warning next to an event. */
  readonly relatedEvents: readonly RelatedEventRef[];

  readonly evidenceManifest: readonly EvidenceItem[];
  readonly attribution: readonly Attribution[];
}

/** The projected view of the event at `asOf`. Every value names the source it came from. */
export interface EventHeadline {
  readonly title: string;
  readonly observedAt: IsoTimestamp;
  readonly lifecycleStatus: LifecycleStatus;
  readonly isActive: boolean;
  readonly providerSeverity: ProviderSeverity | null;
  /** The source whose values are shown as the headline, and why it was preferred. */
  readonly preferredSourceId: string;
  readonly preferenceReason: Reason;
  readonly centroid: { readonly lat: number; readonly lon: number };
  readonly facts: readonly Fact[];
  readonly evidenceIds: readonly EvidenceId[];
}

/** What one source says about this event, at `asOf`. */
export interface EventObservationView {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly productCode: string | null;
  /**
   * The agency credited with this specific solution (EMSC `auth`, USGS `net`). It is a column,
   * not an attribute, because independence depends on it: EMSC republishing an NEIC solution is
   * not a second opinion, even though the source id differs (docs/DATA_SOURCES.md §6.1).
   */
  readonly contributor: string | null;
  /** How this record is attached to the canonical event. */
  readonly relation: LinkRelation;
  readonly matchKind: LinkMatchKind;
  readonly isDerivedCopy: boolean;
  /** The provider's own identifier, e.g. `us7000tikb`. */
  readonly primaryKey: string;
  /** Other identifiers the provider has used for the same record. */
  readonly aliases: readonly string[];
  readonly versionId: string;
  readonly versionSeq: number;
  readonly observedAt: IsoTimestamp;
  readonly validFrom: IsoTimestamp | null;
  readonly validTo: IsoTimestamp | null;
  readonly sourceUpdatedAt: IsoTimestamp | null;
  readonly ingestedAt: IsoTimestamp;
  readonly lifecycleStatus: LifecycleStatus;
  readonly providerSeverity: ProviderSeverity | null;
  /** The provider's status word, verbatim, e.g. `reviewed`. */
  readonly providerStatus: string | null;
  readonly title: string | null;
  readonly sourceUrl: string | null;
  readonly facts: readonly Fact[];
  readonly evidenceId: EvidenceId;
}

/** One version, as a step in the event's history. */
export interface EventTimelineEntry {
  readonly versionId: string;
  readonly versionSeq: number;
  readonly sourceId: string;
  readonly ingestedAt: IsoTimestamp;
  readonly observedAt: IsoTimestamp;
  readonly sourceUpdatedAt: IsoTimestamp | null;
  readonly lifecycleStatus: LifecycleStatus;
  /** Deterministic sentence, e.g. "USGS revised the magnitude from M5.1 to M5.3". */
  readonly summary: string;
  /** Which normalized fields differ from the previous version of the same record. */
  readonly changedFields: readonly string[];
  readonly changes: readonly {
    readonly code: string;
    readonly label: string;
    readonly before: Fact['value'] | null;
    readonly after: Fact['value'] | null;
  }[];
  readonly evidenceId: EvidenceId;
}

/** Why GeoNerva linked these records — and what it refused to link. */
export interface CorrelationView {
  readonly algorithmVersion: string;
  readonly decisions: readonly CorrelationDecisionView[];
  /**
   * Pairs that scored close but were not merged. Shown as "possibly the same event", never
   * silently merged (docs/DOMAIN_MODEL.md §4.8).
   */
  readonly possibleMatches: readonly PossibleMatchView[];
  readonly agreementLevel: AgreementLevel;
}

export interface CorrelationDecisionView {
  readonly linkId: string;
  readonly sourceId: string;
  readonly primaryKey: string;
  readonly relation: LinkRelation;
  readonly matchKind: LinkMatchKind;
  readonly confidence: number | null;
  readonly reasons: readonly Reason[];
  readonly linkedAt: IsoTimestamp;
  readonly unlinkedAt: IsoTimestamp | null;
  readonly unlinkReason: string | null;
  readonly evidenceId: EvidenceId;
}

export interface PossibleMatchView {
  readonly otherPublicId: string | null;
  readonly sourceId: string;
  readonly primaryKey: string;
  readonly score: number;
  readonly reasons: readonly Reason[];
  readonly evaluatedAt: IsoTimestamp;
}

/** A `RELATED` edge, never `SAME` (`event_relations`). */
export interface RelatedEventRef {
  readonly subjectRef: SubjectRef;
  readonly publicId: string;
  readonly hazardType: HazardType;
  readonly relation: string;
  readonly label: string;
  readonly href: string;
  readonly reasons: readonly Reason[];
}
