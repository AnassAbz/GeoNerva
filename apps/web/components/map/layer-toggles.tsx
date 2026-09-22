'use client';

/**
 * Per-family map layer toggles (docs/PRODUCT.md §6.5). Native checkboxes inside a fieldset, so
 * they are reachable with Tab and toggled with Space, and each label is a ≥ 44 px target.
 */

import type { HazardFamily } from '@geonerva/domain';

import { COPY } from '../../lib/view/copy.ts';
import { FAMILY_META } from '../../lib/view/families.ts';
import { FamilyGlyph } from '../ui/shape.tsx';

export function LayerToggles({
  families,
  enabled,
  onChange,
}: {
  readonly families: readonly HazardFamily[];
  readonly enabled: ReadonlySet<HazardFamily>;
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
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
