'use client';

/**
 * Per-family map layer toggles (docs/PRODUCT.md §6.5). Native checkboxes inside a fieldset, so
 * they are reachable with Tab and toggled with Space, and each label is a ≥ 44 px target.
 */

import type { FamilyAvailability, HazardFamily } from '@geonerva/domain';

import { COPY } from '../../lib/view/copy.ts';
import { FAMILY_META } from '../../lib/view/families.ts';
import { FamilyGlyph } from '../ui/shape.tsx';

/**
 * The layer list, with what the map can say about each family beside its toggle.
 *
 * A map has exactly one way to show "nothing here", and it was being used for two opposite facts:
 * a family with no source in this deployment drew the same empty viewport as a genuinely quiet one
 * (QA round 2, H-4). `PRODUCT.md` §7's first row forbids that shape and §9.8 exists because
 * "nothing found" and "cannot tell you" look alike on a screen.
 *
 * The verdict comes from the briefing, which already computes it, rather than being re-derived
 * here — the map and the cards cannot disagree about one fact at one knowledge time if only one
 * of them decides it. A family GeoNerva cannot speak for is still listed, still toggleable, and
 * labelled: hiding it would be a different way of saying nothing.
 *
 * `MapFeaturesResponse` itself carries no coverage field, so an HTTP client asking `/events`
 * directly still cannot tell the two cases apart. That is ADR-042, awaiting the owner.
 */
export function LayerToggles({
  families,
  enabled,
  availability,
  onChange,
}: {
  readonly families: readonly HazardFamily[];
  readonly enabled: ReadonlySet<HazardFamily>;
  /** Per-family verdict from the briefing. An absent entry means nothing is claimed either way. */
  readonly availability?: Readonly<Partial<Record<HazardFamily, FamilyAvailability>>>;
  readonly onChange: (family: HazardFamily, on: boolean) => void;
}) {
  return (
    <fieldset className="rounded-lg border border-line bg-surface p-2">
      <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
        {COPY.map.layers}
      </legend>
      <div className="flex flex-wrap gap-1">
        {families.map((family) => {
          const meta = FAMILY_META[family];
          const id = `layer-${family.toLowerCase()}`;
          const verdict = availability?.[family];
          const cannotSay = verdict === 'NOT_COVERED' || verdict === 'UNAVAILABLE' ? verdict : null;
          return (
            <label
              key={family}
              htmlFor={id}
              className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-raised"
            >
              <input
                id={id}
                type="checkbox"
                checked={enabled.has(family)}
                onChange={(event) => {
                  onChange(family, event.currentTarget.checked);
                }}
                className="h-4 w-4 accent-link"
              />
              <FamilyGlyph shape={meta.shape} pattern={meta.pattern} color={meta.color} size={14} />
              {meta.label}
              {cannotSay === null ? null : (
                <span className="text-xs text-fg-muted">{COPY.map.cannotSay[cannotSay]}</span>
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
