import { describe, expect, it } from 'vitest';
import { ageText, compact, fmt, isStale, short } from '../src/renderer/format';

const now = Date.parse('2026-11-15T12:00:00Z');

describe('format', () => {
  it('formats numbers', () => {
    expect(fmt(1708)).toBe('1,708');
    expect(fmt(12.46)).toBe('12.5');
    expect(compact(471810.1)).toBe('471.8k');
    expect(compact(1_254_000)).toBe('1.25M');
    expect(compact(950)).toBe('950');
    expect(short(3657)).toBe('3.7k');
    expect(short(12_600)).toBe('13k');
    expect(short(950.4)).toBe('950');
  });

  it('describes ages', () => {
    expect(ageText('2026-11-15T11:59:50Z', now)).toBe('just now');
    expect(ageText('2026-11-15T11:20:00Z', now)).toBe('40 min ago');
    expect(ageText('2026-11-15T07:00:00Z', now)).toBe('5 h ago');
    expect(ageText('2026-11-12T12:00:00Z', now)).toBe('3 days ago');
    expect(ageText('nonsense', now)).toBe('at an unknown time');
  });

  it('flags states older than three days', () => {
    expect(isStale('2026-11-13T12:00:00Z', now)).toBe(false);
    expect(isStale('2026-11-11T12:00:00Z', now)).toBe(true);
  });
});
