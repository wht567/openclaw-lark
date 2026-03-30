/**
 * Tests for pure utility functions exported from src/card/builder.ts.
 */

import { describe, expect, it } from 'vitest';
import { buildCardContent, compactNumber, formatFooterRuntimeSegments } from '../src/card/builder';

// ---------------------------------------------------------------------------
// compactNumber
// ---------------------------------------------------------------------------

describe('compactNumber', () => {
  it('formats values across ranges', () => {
    expect(compactNumber(0)).toBe('0');
    expect(compactNumber(999)).toBe('999');
    expect(compactNumber(1000)).toBe('1.0k');
    expect(compactNumber(1250)).toBe('1.3k');
    expect(compactNumber(100_000)).toBe('100k');
    expect(compactNumber(1_000_000)).toBe('1.0m');
    expect(compactNumber(123_456_789)).toBe('123m');
  });
});

// ---------------------------------------------------------------------------
// formatFooterRuntimeSegments
// ---------------------------------------------------------------------------

describe('formatFooterRuntimeSegments', () => {
  it('renders configured runtime metrics split into primary and detail lines', () => {
    const result = formatFooterRuntimeSegments({
      footer: {
        status: true,
        elapsed: true,
        tokens: true,
        cache: true,
        context: true,
        model: true,
      },
      elapsedMs: 12_300,
      metrics: {
        inputTokens: 1200,
        outputTokens: 3500,
        cacheRead: 800,
        cacheWrite: 200,
        totalTokens: 4500,
        totalTokensFresh: true,
        contextTokens: 128000,
        model: 'claude-opus-4-6',
      },
    });

    // Primary line: status, elapsed, model
    expect(result.primaryZh).toEqual(['已完成', '耗时 12.3s', 'claude-opus-4-6']);
    expect(result.primaryEn).toEqual(['Completed', 'Elapsed 12.3s', 'claude-opus-4-6']);

    // Detail line: tokens, cache, context
    expect(result.detailZh).toEqual(['↑ 1.2k ↓ 3.5k', '缓存 800/200 (36%)', '上下文 4.5k/128k (4%)']);
    expect(result.detailEn).toEqual(['↑ 1.2k ↓ 3.5k', 'Cache 800/200 (36%)', 'Context 4.5k/128k (4%)']);
  });

  it('respects missing metrics and status variants', () => {
    const stopped = formatFooterRuntimeSegments({
      footer: { status: true, tokens: true, cache: true, context: true, model: true },
      isAborted: true,
      metrics: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        totalTokensFresh: false,
        contextTokens: 4096,
        model: ' ',
      },
    });

    expect(stopped.primaryZh).toEqual(['已停止']);
    expect(stopped.primaryEn).toEqual(['Stopped']);
    expect(stopped.detailZh).toEqual(['↑ 100 ↓ 50']);
    expect(stopped.detailEn).toEqual(['↑ 100 ↓ 50']);

    const errored = formatFooterRuntimeSegments({
      footer: { status: true, elapsed: true },
      elapsedMs: 1000,
      isError: true,
    });

    expect(errored.primaryZh).toEqual(['出错', '耗时 1.0s']);
    expect(errored.primaryEn).toEqual(['Error', 'Elapsed 1.0s']);
    expect(errored.detailZh).toEqual([]);
    expect(errored.detailEn).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildCardContent – footer rendered as a single markdown element with \n
// ---------------------------------------------------------------------------

describe('buildCardContent – footer line joining', () => {
  /** Extract footer markdown elements (notation-sized) from the card's top-level elements array. */
  function footerElements(card: ReturnType<typeof buildCardContent>) {
    const elements = (card as { elements?: Array<Record<string, unknown>> }).elements ?? [];
    return elements.filter((el) => el.tag === 'markdown' && el.text_size === 'notation');
  }

  it('merges primary and detail lines into one markdown element with \\n', () => {
    const card = buildCardContent('complete', {
      text: 'hello',
      footer: { status: true, elapsed: true, tokens: true, cache: true, context: true, model: true },
      footerMetrics: {
        inputTokens: 1000,
        outputTokens: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1200,
        totalTokensFresh: true,
        contextTokens: 128000,
        model: 'test-model',
      },
      elapsedMs: 5000,
    });

    const fes = footerElements(card);

    // Should be exactly ONE footer element (not two)
    expect(fes).toHaveLength(1);

    // The zh_cn content should contain \n joining the two lines
    const zhContent = (fes[0].i18n_content as Record<string, string>)?.zh_cn;
    const lines = zhContent.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('已完成');
    expect(lines[0]).toContain('耗时');
    expect(lines[0]).toContain('test-model');
    expect(lines[1]).toContain('↑');
    expect(lines[1]).toContain('缓存');
    expect(lines[1]).toContain('上下文');
  });

  it('renders single line when only primary segments exist', () => {
    const card = buildCardContent('complete', {
      text: 'hello',
      footer: { status: true, elapsed: true },
      elapsedMs: 3000,
    });

    const fes = footerElements(card);
    expect(fes).toHaveLength(1);

    const content = fes[0].content as string;
    expect(content).not.toContain('\n');
  });

  it('renders no footer element when all footer flags are off', () => {
    const card = buildCardContent('complete', { text: 'hello' });
    expect(footerElements(card)).toHaveLength(0);
  });
});
