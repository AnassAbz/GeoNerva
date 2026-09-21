/**
 * The structured-output schemas (ARCHITECTURE §11.2, §11.3).
 *
 * Two calls, not five (ADR-012): the **Interpreter** fulfils the Evidence Analyst, Change Analyst,
 * Relevance Explainer and Composer roles as sections of one schema, and the **Skeptic** receives
 * the packet and the draft and may only flag or remove. Splitting the four roles into four calls
 * multiplies cost and latency for no added capability, because they all consume the same packet
 * and are all forbidden from adding facts.
 *
 * Structured outputs make the response schema-valid *by construction*, and these schemas re-check
 * it anyway. That is not redundancy: a schema-valid document can still be semantically false, so
 * validation has to run regardless — and if it is running, it costs nothing to also stop trusting
 * the transport. `safeParse` everywhere, so a malformed document is a verdict rather than a throw.
 *
 * ### What the shapes enforce structurally
 *
 * Each field that carries a claim also carries `evidenceIds`, so an uncited claim is a **schema**
 * error rather than something the validator has to notice. `relevance_explanations` echo the level
 * rather than choosing one, so a changed level is a mismatch against the packet instead of a new
 * opinion. And every array is bounded, because an unbounded one is a cost and a denial-of-service
 * surface in a worker with a daily budget.
 */

import { z } from 'zod';

/** An evidence reference, in the canonical grammar. Shape only; existence is rule 2. */
const evidenceId = z
  .string()
  .regex(/^EV:(OBS|FCV|FDS|RUN|COR|BAS|REL|CHG):[0-9a-f:-]+$/u, 'not a canonical evidence id');

const claimText = z.string().trim().min(1).max(600);

/**
 * One observation the model drew from the evidence.
 *
 * `numbers` is the model's own declaration of the figures it used. It is not trusted — rule 3
 * extracts every number from `claim` independently — but requiring it makes an uncited figure a
 * visible act rather than an oversight, and it gives the Skeptic something concrete to check.
 */
const keyObservation = z.object({
  claim: claimText,
  evidenceIds: z.array(evidenceId).min(1).max(12),
  numbers: z.array(z.string().max(40)).max(12).default([]),
});

const changeNarrative = z.object({
  /** Must be one of the packet's change ids, in the packet's order (§11.2). */
  signalId: evidenceId,
  text: claimText,
  evidenceIds: z.array(evidenceId).min(1).max(12),
});

const relevanceExplanation = z.object({
  subjectRef: z.string().trim().min(1).max(80),
  /** **Echoed**, not chosen. A different value is a mismatch, not an opinion (rule 4). */
  level: z.enum(['LOW', 'MODERATE', 'HIGH', 'CRITICAL']),
  text: claimText,
  /** Must be a subset of the subject's own reason codes; the model may not add reasons. */
  reasonCodes: z.array(z.string().trim().min(1).max(64)).max(12),
  evidenceIds: z.array(evidenceId).min(1).max(12),
});

const summary = z.object({
  /** §11.2 caps the summary at 80 words; enforced in the validator, bounded here. */
  text: z.string().trim().min(1).max(1200),
  evidenceIds: z.array(evidenceId).min(1).max(20),
});

export const interpreterOutputSchema = z.object({
  keyObservations: z.array(keyObservation).max(8).default([]),
  changeNarrative: z.array(changeNarrative).max(12).default([]),
  relevanceExplanations: z.array(relevanceExplanation).max(12).default([]),
  summary,
});

export type InterpreterOutput = z.infer<typeof interpreterOutputSchema>;

/** §11.2's problem codes, which are also the validator's own failure vocabulary. */
export const PROBLEM_CODES = [
  'UNSUPPORTED_CLAIM',
  'NUMBER_MISMATCH',
  'PREDICTION_LANGUAGE',
  'SAFETY_CLAIM',
  'STALE_AS_CURRENT',
  'THERMAL_AS_WILDFIRE',
  'CONFLICT_IGNORED',
  'EXAGGERATION',
  'ALERT_PARAPHRASED',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/**
 * The Skeptic's output.
 *
 * It may only remove or flag, never rewrite, so there is no text field for it to put prose in —
 * the schema is the enforcement. A Skeptic that cannot be parsed is treated as `REJECT`, because
 * the one thing worse than a missing second opinion is a second opinion that was assumed
 * favourable.
 */
export const skepticOutputSchema = z.object({
  verdict: z.enum(['PASS', 'REVISE', 'REJECT']),
  findings: z
    .array(
      z.object({
        /*
         * Structural, and enforced here rather than trusted.
         *
         * `ValidationFinding.claimPath` is documented as "where in the output", and the
         * `SKEPTIC_REJECTED` path copies this value into an operator-facing field that the
         * codebase promises is model-free. An unconstrained string let a Skeptic — or a compromised
         * provider response — put arbitrary text, including newlines, into `agent_outputs` and
         * into metrics. It is also the only form `dropFlaggedClaims` can act on, so anything else
         * was silently inert.
         */
        claimPath: z
          .string()
          .regex(
            /^(?:summary|(?:keyObservations|changeNarrative|relevanceExplanations)\[\d{1,2}\])$/u,
            'not a claim path',
          ),
        problemCode: z.enum(PROBLEM_CODES),
        note: z.string().trim().max(400).default(''),
      }),
    )
    .max(24)
    .default([]),
});

export type SkepticOutput = z.infer<typeof skepticOutputSchema>;

/**
 * Parses model output without throwing.
 *
 * A malformed document is an outcome the fallback path handles, not an exception that propagates
 * into a request — §11.4's "do not silently coerce invalid output into success" cuts both ways:
 * it must also not turn invalid output into an unhandled failure of the whole briefing.
 */
export function parseInterpreterOutput(
  value: unknown,
):
  | { readonly ok: true; readonly output: InterpreterOutput }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const parsed = interpreterOutputSchema.safeParse(value);
  if (parsed.success) return { ok: true, output: parsed.data };
  return { ok: false, issues: parsed.error.issues.map(describeIssue) };
}

export function parseSkepticOutput(
  value: unknown,
):
  | { readonly ok: true; readonly output: SkepticOutput }
  | { readonly ok: false; readonly issues: readonly string[] } {
  const parsed = skepticOutputSchema.safeParse(value);
  if (parsed.success) return { ok: true, output: parsed.data };
  return { ok: false, issues: parsed.error.issues.map(describeIssue) };
}

/**
 * An issue as a short, safe string.
 *
 * The path and the message only — never the offending *value*. A validation message is logged and
 * may reach an operator, and echoing model output into a log is how provider text ends up
 * somewhere it was never reviewed for.
 */
function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
  return `${path}: ${issue.message}`;
}
