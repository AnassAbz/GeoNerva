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

/**
 * The echoed model name, bounded.
 *
 * `AiCallResult.document` is explicitly untrusted and `model` arrives in the same response, yet it
 * goes into a read model rendered beside the AI text and into logs. Bounding the charset and the
 * length is cheap; a caller that wants a stronger guarantee should compare it against the
 * configured `AI_MODEL`.
 */
function safeModelName(raw: string): string {
  const cleaned = raw.trim().replace(/[^A-Za-z0-9._:-]/gu, '');
  return cleaned.slice(0, 64) === '' ? 'unknown' : cleaned.slice(0, 64);
}

import {
  MAX_PACKET_BYTES,
  PacketRefusedError,
  buildPacket,
  renderPacket,
  type BriefingPacket,
} from './packet.ts';
import {
  parseInterpreterOutput,
  parseSkepticOutput,
  type InterpreterOutput,
  type ProblemCode,
} from './schema.ts';
import { validateInterpreterOutput, type ValidationFinding } from './validate.ts';

/** Why the AI path did not produce shown text. Every value is a fallback to the templates. */
export const FALLBACK_REASONS = [
  /** `AI_MODE=disabled`, which is the default and not a failure. */
  'DISABLED',
  'NO_API_KEY',
  'AD_HOC_LOCATION',
  'BUDGET_EXHAUSTED',
  /** The packet exceeded `MAX_PACKET_BYTES`; declining is cheaper than spending. */
  'PACKET_TOO_LARGE',
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
  /**
   * **Must be explicitly true to spend.** ADR-012 calls the daily budget a hard cap, and this used
   * to read `withinBudget === false`, so `undefined` proceeded — the one control described as hard
   * was the only one that failed *open*, while `mode` and `client` both failed closed. A caller
   * that has not checked its budget has not earned a call.
   */
  readonly withinBudget?: boolean;
  readonly signal?: AbortSignal;
  /** Wall-clock budget for each model call. SECURITY.md M5 lists timeouts as a cost mitigation. */
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

/** Default per-call timeout. A client that never settles must not hang the worker job. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;

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
  const client = options.client;
  if (client === undefined) {
    return declined('NO_API_KEY', packet.contentSha256, packetBytes);
  }
  if (options.withinBudget !== true) {
    return declined('BUDGET_EXHAUSTED', packet.contentSha256, packetBytes);
  }
  if (packetBytes > MAX_PACKET_BYTES) {
    /*
     * Declining is cheaper than spending. An oversized packet is a cost incident rather than a
     * data problem, and the deterministic briefing it falls back to is already complete.
     */
    return declined('PACKET_TOO_LARGE', packet.contentSha256, packetBytes);
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
    const call = await withTimeout(
      (signal) => client.interpret(rendered, signal),
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      options.signal,
    );
    interpretMs = Date.now() - started;
    model = safeModelName(call.model);
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
  /** Carried into the outcome, so a Skeptic's objection is never invisible. */
  let skepticNotes: readonly ValidationFinding[] = [];
  try {
    const started = Date.now();
    const call = await withTimeout(
      (signal) => client.critique(rendered, JSON.stringify(firstPass.repaired), signal),
      options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
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
      return fail('SKEPTIC_REJECTED', skepticFindings(parsed.output.findings));
    }
    /*
     * `REVISE` is not a licence to rewrite: the Skeptic may only remove. Its findings name claim
     * paths, those claims are dropped, and the result is re-validated — so a Skeptic cannot cause
     * anything to be *added*, only subtracted.
     */
    if (parsed.output.verdict === 'REVISE') {
      /*
       * A `REVISE` that changes nothing is a **rejection**, not a pass.
       *
       * `dropFlaggedClaims` can only remove indexed claims, so a Skeptic objecting to `summary` —
       * or, before the schema was tightened, to `keyObservations.0` — left the document untouched.
       * The final validation then re-approved the very document the first pass had already
       * approved, `findings` came back empty, and the objection vanished: a failure swallowed into
       * success, with the Skeptic's only effective verdict being `REJECT`.
       *
       * So the revision has to actually revise. If it does not, the objection stands.
       */
      const revised = dropFlaggedClaims(
        firstPass.repaired,
        parsed.output.findings.map((finding) => finding.claimPath),
      );
      if (claimCount(revised) === claimCount(firstPass.repaired)) {
        return fail('SKEPTIC_REJECTED', skepticFindings(parsed.output.findings));
      }
      draft = revised;
      skepticNotes = skepticFindings(parsed.output.findings);
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

  /*
   * The outcome reports the **first** pass's status and findings alongside the final ones.
   *
   * `finalPass` runs on the already-repaired document, so it necessarily reports `PASSED` with no
   * findings. Publishing that alone recorded a clean pass in `agent_outputs` for an output in
   * which claims had failed grounding and been removed — §11.4 requires the outcome to be
   * recorded, and "repaired" is the outcome that was being lost.
   */
  const status: AiValidationStatus = firstPass.status === 'PASSED' ? finalPass.status : 'REPAIRED';
  const allFindings = [...firstPass.findings, ...skepticNotes, ...finalPass.findings];

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
      validationStatus: status === 'PASSED' ? 'PASSED' : 'REPAIRED',
      sections: toSections(finalPass.repaired),
      evidenceIds: finalPass.evidenceIds,
      disclaimer: DISCLAIMER,
      generatedAt: now().toISOString(),
    },
    attempted: true,
    fallbackReason: null,
    validationStatus: status,
    findings: allFindings,
    metrics: metrics(),
  };
}

/** How many claims a document carries, for the "a revision must revise" check. */
function claimCount(output: InterpreterOutput): number {
  return (
    output.keyObservations.length +
    output.changeNarrative.length +
    output.relevanceExplanations.length
  );
}

/** A Skeptic's findings, with its note replaced by a constant. Its paths are schema-checked. */
function skepticFindings(
  findings: readonly { readonly claimPath: string; readonly problemCode: ProblemCode }[],
): readonly ValidationFinding[] {
  return findings.map((finding) => ({
    claimPath: finding.claimPath,
    problemCode: finding.problemCode,
    note: 'flagged by the reviewing pass',
  }));
}

/**
 * Runs one model call under a wall-clock bound.
 *
 * The timer is cleared on both paths, and the timeout is surfaced as an `AiClientError` so it
 * joins the ordinary fallback vocabulary rather than becoming an unhandled rejection. It does not
 * cancel the underlying request — a client that ignores its `AbortSignal` will keep running — but
 * it does stop the worker job waiting on it, which is the failure that matters here.
 */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort();
  };
  outer?.addEventListener('abort', onAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiClientError('TIMEOUT', `the model call exceeded ${String(timeoutMs)} ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
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
