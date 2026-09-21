/**
 * The AI boundary and its fallback (ARCHITECTURE §11, ADR-012).
 *
 * ```text
 * AI path fails
 *    ↓
 * safe diagnostic
 *    ↓
 * deterministic briefing
 * ```
 *
 * The single property this file exists to guarantee: **an AI failure never makes GeoNerva
 * unavailable.** `AI_MODE=disabled` is the default and the deterministic copy is the product's
 * language, so the absence of a model is the normal case rather than an error — which means every
 * failure mode here degrades to something that was already complete.
 *
 * ### Why the client is injected
 *
 * `AiClient` is an interface, and this module never imports an SDK. That is what makes the failure
 * modes testable: a timeout, a rate limit, a refusal, a malformed document and an abort are all
 * just clients, and the fallback path is exercised with the same code that will run in production
 * rather than with a mock of it. It also keeps `packages/ai` free of network dependencies, which
 * the dependency rules require anyway.
 *
 * ### Nothing here decides what is true
 *
 * The client produces a document; `validate.ts` decides whether any of it may be shown. This
 * module's only judgements are operational: whether to call at all, what to do when a call fails,
 * and what to record about it.
 */

import type { AiBriefingView, AiSection, AiValidationStatus } from '@geonerva/domain';

import { buildPacket, renderPacket, PacketRefusedError, type BriefingPacket } from './packet.ts';
import { parseInterpreterOutput, parseSkepticOutput, type InterpreterOutput } from './schema.ts';
import { validateInterpreterOutput, type ValidationFinding } from './validate.ts';

/** Why the AI path did not produce shown text. Every value is a fallback to the templates. */
export const FALLBACK_REASONS = [
  /** `AI_MODE=disabled`, which is the default and not a failure. */
  'DISABLED',
  'NO_API_KEY',
  'AD_HOC_LOCATION',
  'BUDGET_EXHAUSTED',
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'RATE_LIMITED',
  'ABORTED',
  /** The document did not parse, or did not match the schema. */
  'MALFORMED_OUTPUT',
  /** The model declined to answer. */
  'REFUSED',
  /** Validation rejected it: §11.4's summary rule or the 30 % claim threshold. */
  'GROUNDING_FAILED',
  'SKEPTIC_REJECTED',
  'INTERNAL_ERROR',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** What a client can go wrong with, mapped to a fallback reason rather than to an exception. */
export class AiClientError extends Error {
  readonly reason: Extract<
    FallbackReason,
    'PROVIDER_UNAVAILABLE' | 'TIMEOUT' | 'RATE_LIMITED' | 'ABORTED' | 'REFUSED' | 'INTERNAL_ERROR'
  >;

  constructor(reason: AiClientError['reason'], message: string) {
    /*
     * The message is the *class* of failure, never the provider's response body and never a
     * prompt. A stack trace or a raw error from an HTTP client is exactly the kind of thing that
     * carries a URL with a key in it.
     */
    super(message);
    this.name = 'AiClientError';
    this.reason = reason;
  }
}

export interface AiCallResult {
  /** The parsed JSON document the model returned. Shape is not trusted. */
  readonly document: unknown;
  readonly model: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly costMicros?: number;
}

/**
 * The model boundary.
 *
 * Two calls, as ADR-012 fixes: the Interpreter drafts, the Skeptic reviews. Both receive the
 * rendered packet; the Skeptic also receives the draft. Neither has tools.
 */
export interface AiClient {
  interpret(packet: string, signal?: AbortSignal): Promise<AiCallResult>;
  critique(packet: string, draft: string, signal?: AbortSignal): Promise<AiCallResult>;
}

export interface GenerateOptions {
  readonly briefing: Parameters<typeof buildPacket>[0];
  /** Absent or `disabled` short-circuits to the deterministic path without a call. */
  readonly mode?: 'disabled' | 'anthropic' | 'local';
  readonly client?: AiClient;
  readonly promptVersion?: string;
  /** False when the daily budget is spent (ADR-012's hard cap). */
  readonly withinBudget?: boolean;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** The record an operator needs, and nothing a log should not hold. */
export interface GenerateOutcome {
  /** The block to place in `LocationBriefing.ai`, or `null` for the deterministic path. */
  readonly ai: AiBriefingView | null;
  readonly attempted: boolean;
  readonly fallbackReason: FallbackReason | null;
  readonly validationStatus: AiValidationStatus | null;
  readonly findings: readonly ValidationFinding[];
  /** Observability (§9 of the P7 brief). Sizes, not contents. */
  readonly metrics: {
    readonly packetBytes: number;
    readonly interpretMs: number | null;
    readonly critiqueMs: number | null;
    readonly model: string | null;
    readonly tokensIn: number | null;
    readonly tokensOut: number | null;
    readonly costMicros: number | null;
    /** The snapshot hash the attempt was keyed by, which is the AI cache key. */
    readonly snapshotSha256: string;
  };
}

const DISCLAIMER =
  'Written with AI assistance from GeoNerva’s own data, then checked automatically. It adds no ' +
  'facts and is not emergency advice; follow your local authorities.';

/**
 * Runs the AI path, or declines to.
 *
 * Never throws for an AI reason. Every failure becomes a `fallbackReason` and a `null` block, and
 * the caller places that `null` in a briefing that was already complete — which is the difference
 * between an optional layer and a dependency.
 */
export async function generateAiBriefing(options: GenerateOptions): Promise<GenerateOutcome> {
  const now = options.now ?? (() => new Date());
  const promptVersion = options.promptVersion ?? 'p7-1';

  /*
   * Build the packet first, because it is also the privacy gate: an ad-hoc coordinate location
   * refuses here, before any client exists, so there is no path on which it reaches a provider.
   */
  let packet: BriefingPacket;
  let rendered: string;
  try {
    packet = buildPacket(options.briefing);
    rendered = renderPacket(packet);
  } catch (error) {
    return declined(
      error instanceof PacketRefusedError ? 'AD_HOC_LOCATION' : 'INTERNAL_ERROR',
      options.briefing.contentSha256,
      0,
    );
  }

  const packetBytes = Buffer.byteLength(rendered, 'utf8');

  if (options.mode === undefined || options.mode === 'disabled') {
    return declined('DISABLED', packet.contentSha256, packetBytes);
  }
  if (options.mode === 'local') {
    // `AI_MODE=local` is a reserved interface stub (§11.3). Reserved is not implemented.
    return declined('PROVIDER_UNAVAILABLE', packet.contentSha256, packetBytes);
  }
  if (options.client === undefined) {
    return declined('NO_API_KEY', packet.contentSha256, packetBytes);
  }
  if (options.withinBudget === false) {
    return declined('BUDGET_EXHAUSTED', packet.contentSha256, packetBytes);
  }

  let interpretMs: number | null = null;
  let critiqueMs: number | null = null;
  let model: string | null = null;
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let costMicros: number | null = null;

  const metrics = () => ({
    packetBytes,
    interpretMs,
    critiqueMs,
    model,
    tokensIn,
    tokensOut,
    costMicros,
    snapshotSha256: packet.contentSha256,
  });

  const fail = (
    reason: FallbackReason,
    findings: readonly ValidationFinding[] = [],
  ): GenerateOutcome => ({
    ai: null,
    attempted: true,
    fallbackReason: reason,
    validationStatus: reason === 'GROUNDING_FAILED' ? 'REJECTED' : null,
    findings,
    metrics: metrics(),
  });

  // ---- Interpreter ----------------------------------------------------------------------------
  let draft: InterpreterOutput;
  try {
    const started = Date.now();
    const call = await options.client.interpret(rendered, options.signal);
    interpretMs = Date.now() - started;
    model = call.model;
    tokensIn = call.tokensIn ?? null;
    tokensOut = call.tokensOut ?? null;
    costMicros = call.costMicros ?? null;

    const parsed = parseInterpreterOutput(call.document);
    if (!parsed.ok) return fail('MALFORMED_OUTPUT');
    draft = parsed.output;
  } catch (error) {
    return fail(error instanceof AiClientError ? error.reason : 'INTERNAL_ERROR');
  }

  /*
   * Validate **before** the Skeptic as well as after (§11.1: "before and after the Skeptic, a
   * deterministic validator is the actual gate"). Spending a second call on a draft that already
   * fails grounding is money for nothing, and it also means a Skeptic that says PASS can never be
   * the reason something invalid was shown.
   */
  const firstPass = validateInterpreterOutput(packet, draft);
  /*
   * `repaired === null` is the whole test. A `REJECTED` verdict always returns a null `repaired`,
   * so checking the status as well was a second condition no test could distinguish — and a
   * predicate that cannot fail is worse documentation than this sentence. The null check is also
   * the one that narrows the type, which is the honest reason to keep it rather than the status.
   */
  if (firstPass.repaired === null) {
    return fail('GROUNDING_FAILED', firstPass.findings);
  }

  // ---- Skeptic --------------------------------------------------------------------------------
  try {
    const started = Date.now();
    const call = await options.client.critique(
      rendered,
      JSON.stringify(firstPass.repaired),
      options.signal,
    );
    critiqueMs = Date.now() - started;
    tokensIn = sum(tokensIn, call.tokensIn);
    tokensOut = sum(tokensOut, call.tokensOut);
    costMicros = sum(costMicros, call.costMicros);

    const parsed = parseSkepticOutput(call.document);
    /*
     * A Skeptic that cannot be parsed is treated as `REJECT` (§11.2's "on failure" column). The
     * one thing worse than no second opinion is a second opinion assumed to be favourable.
     */
    if (!parsed.ok) return fail('SKEPTIC_REJECTED');
    if (parsed.output.verdict === 'REJECT') {
      return fail(
        'SKEPTIC_REJECTED',
        parsed.output.findings.map((finding) => ({
          claimPath: finding.claimPath,
          problemCode: finding.problemCode,
          note: 'flagged by the reviewing pass',
        })),
      );
    }
    /*
     * `REVISE` is not a licence to rewrite: the Skeptic may only remove. Its findings name claim
     * paths, those claims are dropped, and the result is re-validated — so a Skeptic cannot cause
     * anything to be *added*, only subtracted.
     */
    if (parsed.output.verdict === 'REVISE') {
      draft = dropFlaggedClaims(
        firstPass.repaired,
        parsed.output.findings.map((f) => f.claimPath),
      );
    } else {
      draft = firstPass.repaired;
    }
  } catch (error) {
    return fail(error instanceof AiClientError ? error.reason : 'INTERNAL_ERROR');
  }

  // ---- Final gate -----------------------------------------------------------------------------
  const finalPass = validateInterpreterOutput(packet, draft);
  if (finalPass.repaired === null) {
    return fail('GROUNDING_FAILED', finalPass.findings);
  }

  return {
    ai: {
      // Assigned by the Interpreter call above; any failure there returned before this point.
      model,
      promptVersion,
      /*
       * `REJECTED` cannot reach here — the guards above return before it — so the cast the
       * contract wants is safe, and the contract is right to want it: a `REJECTED` output is
       * stored for evaluation and never shown (ADR-012).
       */
      validationStatus: finalPass.status === 'PASSED' ? 'PASSED' : 'REPAIRED',
      sections: toSections(finalPass.repaired),
      evidenceIds: finalPass.evidenceIds,
      disclaimer: DISCLAIMER,
      generatedAt: now().toISOString(),
    },
    attempted: true,
    fallbackReason: null,
    validationStatus: finalPass.status,
    findings: finalPass.findings,
    metrics: metrics(),
  };
}

/** Sections, in a fixed order, so the same output always renders the same way. */
function toSections(output: InterpreterOutput): readonly AiSection[] {
  const sections: AiSection[] = [
    {
      role: 'summary',
      heading: 'In short',
      text: output.summary.text,
      evidenceIds: output.summary.evidenceIds,
    },
  ];

  if (output.keyObservations.length > 0) {
    sections.push({
      role: 'observations',
      heading: 'What the evidence shows',
      text: output.keyObservations.map((entry) => entry.claim).join(' '),
      evidenceIds: [...new Set(output.keyObservations.flatMap((entry) => entry.evidenceIds))],
    });
  }
  if (output.changeNarrative.length > 0) {
    sections.push({
      role: 'changes',
      heading: 'What changed',
      text: output.changeNarrative.map((entry) => entry.text).join(' '),
      evidenceIds: [...new Set(output.changeNarrative.flatMap((entry) => entry.evidenceIds))],
    });
  }
  if (output.relevanceExplanations.length > 0) {
    sections.push({
      role: 'relevance',
      heading: 'Why this matters here',
      text: output.relevanceExplanations.map((entry) => entry.text).join(' '),
      evidenceIds: [...new Set(output.relevanceExplanations.flatMap((entry) => entry.evidenceIds))],
    });
  }
  return sections;
}

/** Removes the claims the Skeptic flagged, by path. Never edits text. */
function dropFlaggedClaims(output: InterpreterOutput, paths: readonly string[]): InterpreterOutput {
  const flagged = new Set(paths);
  const keep = (prefix: string, index: number): boolean =>
    !flagged.has(`${prefix}[${String(index)}]`);

  return {
    keyObservations: output.keyObservations.filter((_, index) => keep('keyObservations', index)),
    changeNarrative: output.changeNarrative.filter((_, index) => keep('changeNarrative', index)),
    relevanceExplanations: output.relevanceExplanations.filter((_, index) =>
      keep('relevanceExplanations', index),
    ),
    summary: output.summary,
  };
}

function declined(
  reason: FallbackReason,
  snapshotSha256: string,
  packetBytes: number,
): GenerateOutcome {
  return {
    ai: null,
    attempted: false,
    fallbackReason: reason,
    validationStatus: null,
    findings: [],
    metrics: {
      packetBytes,
      interpretMs: null,
      critiqueMs: null,
      model: null,
      tokensIn: null,
      tokensOut: null,
      costMicros: null,
      snapshotSha256,
    },
  };
}

function sum(left: number | null, right: number | undefined): number | null {
  if (right === undefined) return left;
  return (left ?? 0) + right;
}
