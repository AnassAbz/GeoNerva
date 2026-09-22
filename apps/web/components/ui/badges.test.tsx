import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  ConfidenceBadge,
  DerivedTag,
  RelevanceBadge,
  SourceBadge,
  SourceDot,
  StatusChip,
} from './badges.tsx';

describe('RelevanceBadge', () => {
  it.each([
    ['LOW', 'Low'],
    ['MODERATE', 'Moderate'],
    ['HIGH', 'High'],
    ['CRITICAL', 'Critical'],
  ] as const)('renders %s with its word, not only a colour', (level, word) => {
    const { container } = render(<RelevanceBadge level={level} />);
    expect(container.textContent).toContain(word);
    expect(container.textContent).toContain('Relevance');
  });
});

describe('StatusChip and SourceDot', () => {
  it.each([
    ['FRESH', 'Fresh'],
    ['DEGRADED', 'Degraded'],
    ['STALE', 'Stale'],
    ['UNAVAILABLE', 'Unavailable'],
  ] as const)('%s carries a text label', (status, label) => {
    render(<StatusChip status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('a source dot names the source and its status in words', () => {
    const { container } = render(<SourceDot sourceId="firms" status="STALE" />);
    expect(container.textContent).toBe('NASA FIRMSStale');
  });

  it('an unknown source id is shown, not hidden', () => {
    render(<SourceBadge sourceId="newsrc" />);
    expect(screen.getByText('NEWSRC')).toBeInTheDocument();
  });
});

describe('DerivedTag and ConfidenceBadge', () => {
  it('marks derived values and explains the tag to assistive technology', () => {
    const { container } = render(<DerivedTag />);
    expect(container.textContent).toContain('Derived');
    expect(container.textContent).toContain('Computed by GeoNerva');
  });

  it('states the confidence level in words', () => {
    const { container } = render(<ConfidenceBadge level="MEDIUM" />);
    expect(container.textContent).toBe('Data confidence: Medium');
  });
});
