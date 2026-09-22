/**
 * The body of `/methodology` (docs/PRODUCT.md §6.9), as plain server-rendered sections.
 *
 * It lives beside the page rather than in it for one reason: the page reads source health, and a
 * component test must be able to assert that a threshold on this page **is** the exported constant
 * the engine uses without standing up a data layer. Everything here is a function of `COPY` and of
 * the four mandated caveats, so `sections.test.tsx` can render it directly and compare each number
 * with the constant it came from.
 *
 * Two kinds of string appear:
 *
 *  - Words the UI writes, from `lib/view/copy.ts`, where every threshold is interpolated from the
 *    engine's own exported configuration. There is no number typed into this file or into that
 *    block of `COPY`.
 *  - The **mandated caveats**, rendered verbatim from the constants the assessments themselves
 *    attach — `THERMAL_DETECTION_CAVEAT`, `FLOOD_MODELLED_AREA_CAVEAT`,
 *    `EARTHQUAKE_ELEVATED_CAVEAT`, `AFTERSHOCK_CAVEAT`. Copying their wording into `COPY` would
 *    make the methodology page able to disagree with the card it explains, which is the whole
 *    failure this page is built to avoid.
 */

import { AFTERSHOCK_CAVEAT, EARTHQUAKE_ELEVATED_CAVEAT } from '@geonerva/baselines';
import type { SourceStatusEntry } from '@geonerva/domain';
import type { ReactNode } from 'react';
import { FLOOD_MODELLED_AREA_CAVEAT, THERMAL_DETECTION_CAVEAT } from '@geonerva/relevance';

import { COPY } from '../../lib/view/copy.ts';
import { RELEVANCE_LABEL, formatDuration } from '../../lib/view/format.ts';

/** Section ids are anchor targets: `/methodology#fire-trend` is linked from history responses. */
export const METHODOLOGY_SECTIONS = [
  { id: 'sources', title: COPY.methodology.sections.sources },
  { id: 'correlation', title: COPY.methodology.sections.correlation },
  { id: 'relevance', title: COPY.methodology.sections.relevance },
  { id: 'eq-count', title: COPY.methodology.sections.baselines },
  { id: 'fire-trend', title: COPY.methodology.sections.fireTrend },
  { id: 'gdacs-context', title: COPY.methodology.sections.gdacs },
  { id: 'changes', title: COPY.methodology.sections.changes },
] as const;

interface Rule {
  readonly label: string;
  readonly value: string;
}

/**
 * A rule table as a definition list.
 *
 * Stacked below `sm`, two columns above it. At 320 px a label and a sentence side by side would
 * either overflow or wrap to one word a line, so each pair keeps its own wrapper below `sm` and
 * only becomes `display: contents` — grid items of the outer `dl` — once there is room for two
 * columns. `minmax(0, …)` and `break-words` are what stop a long unbroken token from widening the
 * page instead of wrapping inside it.
 */
function RuleList({ rules }: { readonly rules: readonly Rule[] }) {
  return (
    <dl className="mt-3 space-y-3 text-sm sm:grid sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-3 sm:space-y-0">
      {rules.map((rule) => (
        <div key={rule.label} className="space-y-1 sm:contents sm:space-y-0">
          <dt className="font-semibold break-words">{rule.label}</dt>
          <dd className="text-fg-muted break-words">{rule.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="mt-8 scroll-mt-4">
      <h2 id={`${id}-title`} className="mb-2 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SubHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className="mt-5 text-sm font-semibold tracking-wide uppercase">{children}</h3>;
}

/** A caveat GeoNerva is obliged to state, in the wording the engine itself attaches. */
function Caveat({ text }: { readonly text: string }) {
  return (
    <p className="mt-3 border-l-2 border-line pl-3 text-sm text-fg-muted italic break-words">
      {text}
    </p>
  );
}

function Bullets({ items }: { readonly items: readonly string[] }) {
  return (
    <ul className="mt-3 list-outside list-disc space-y-2 pl-5 text-sm text-fg-muted">
      {items.map((item) => (
        <li key={item} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

function SourceEntry({ source }: { readonly source: SourceStatusEntry }) {
  const expected = source.health.expected;
  const copy = COPY.methodology.sources;
  return (
    <li data-source={source.sourceId} className="border-t border-line pt-3">
      <p className="font-semibold">{source.name}</p>
      <dl className="mt-1 space-y-1 text-sm text-fg-muted">
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{copy.cadence}</dt>
          <dd>{formatDuration(expected.pollIntervalS)}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{copy.latency}</dt>
          <dd>
            {expected.dataCurrentWithinS === null
              ? copy.noLatency
              : formatDuration(expected.dataCurrentWithinS)}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{copy.coverage}</dt>
          <dd className="break-words">{source.coverageNote ?? copy.noCoverage}</dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="font-medium">{copy.licence}</dt>
          <dd className="break-words">{source.licence}</dd>
        </div>
      </dl>
    </li>
  );
}

export function MethodologySections({
  sources,
}: {
  readonly sources: readonly SourceStatusEntry[];
}) {
  const copy = COPY.methodology;
  return (
    <>
      <Section id="sources" title={copy.sections.sources}>
        <p className="text-sm text-fg-muted">{copy.sources.intro}</p>
        <ul className="mt-3 space-y-3">
          {sources.map((source) => (
            <SourceEntry key={source.sourceId} source={source} />
          ))}
        </ul>
        <SubHeading>{copy.sources.limitsHeading}</SubHeading>
        <p className="mt-2 text-sm text-fg-muted">{copy.sources.completeness}</p>
        <Caveat text={THERMAL_DETECTION_CAVEAT} />
        <Caveat text={FLOOD_MODELLED_AREA_CAVEAT} />
        <p className="mt-3 text-sm text-fg-muted">{copy.sources.retention}</p>
      </Section>

      <Section id="correlation" title={copy.sections.correlation}>
        <p className="text-sm text-fg-muted">{copy.correlation.intro}</p>
        <RuleList rules={copy.correlation.rules} />
        <SubHeading>{copy.correlation.agreementHeading}</SubHeading>
        <RuleList rules={copy.correlation.agreementRules} />
        <p className="mt-3 text-sm text-fg-muted">{copy.correlation.independence}</p>
      </Section>

      <Section id="relevance" title={copy.sections.relevance}>
        <p className="text-sm text-fg-muted">{copy.relevance.intro}</p>
        <p className="mt-3 text-sm text-fg-muted">{copy.relevance.criticalNote}</p>

        <SubHeading>{copy.relevance.eqHeading}</SubHeading>
        <p className="mt-2 text-sm text-fg-muted">{copy.relevance.eqIntro}</p>
        <RuleList
          rules={copy.relevance.eqBands.map((band) => ({
            label: RELEVANCE_LABEL[band.level],
            value: band.condition,
          }))}
        />
        <p className="mt-3 text-sm text-fg-muted">{copy.relevance.eqFloor}</p>
        <Bullets items={copy.relevance.eqExtra} />

        <SubHeading>{copy.relevance.fireHeading}</SubHeading>
        <RuleList rules={copy.relevance.fireRules} />
        <Caveat text={THERMAL_DETECTION_CAVEAT} />

        <SubHeading>{copy.relevance.gdacsHeading}</SubHeading>
        <RuleList rules={copy.relevance.gdacsRules} />
        <Caveat text={FLOOD_MODELLED_AREA_CAVEAT} />

        <SubHeading>{copy.relevance.versionsHeading}</SubHeading>
        <p className="mt-2 text-sm text-fg-muted">{copy.relevance.versions}</p>
      </Section>

      <Section id="eq-count" title={copy.sections.baselines}>
        <p className="text-sm text-fg-muted">{copy.eqBaseline.intro}</p>
        <RuleList rules={copy.eqBaseline.rules} />
        <p className="mt-3 text-sm text-fg-muted">{copy.eqBaseline.noLowBand}</p>
        <p className="mt-3 text-sm text-fg-muted">{copy.eqBaseline.retentionFloor}</p>
        <SubHeading>{copy.caveatHeading}</SubHeading>
        <Caveat text={EARTHQUAKE_ELEVATED_CAVEAT} />
        <Caveat text={AFTERSHOCK_CAVEAT} />
      </Section>

      <Section id="fire-trend" title={copy.sections.fireTrend}>
        <p className="text-sm text-fg-muted">{copy.fireTrend.intro}</p>
        <RuleList rules={copy.fireTrend.rules} />
        <SubHeading>{copy.fireTrend.limitationsHeading}</SubHeading>
        <Bullets items={copy.fireTrend.limitations} />
        <p className="mt-3 text-sm text-fg-muted">{copy.fireTrend.trendWording}</p>
        <Caveat text={THERMAL_DETECTION_CAVEAT} />
      </Section>

      <Section id="gdacs-context" title={copy.sections.gdacs}>
        <p className="text-sm text-fg-muted">{copy.gdacsContext.intro}</p>
        <RuleList rules={copy.gdacsContext.rules} />
      </Section>

      <Section id="changes" title={copy.sections.changes}>
        <p className="text-sm text-fg-muted">{copy.changesMethod.intro}</p>
        <RuleList rules={copy.changesMethod.rules} />
        <p className="mt-3 text-sm text-fg-muted">{copy.changesMethod.suppressed}</p>
      </Section>
    </>
  );
}
