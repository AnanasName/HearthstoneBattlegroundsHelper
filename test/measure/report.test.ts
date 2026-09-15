import { describe, expect, it } from 'vitest';

import { comparable, noiseBand, renderMarkdown, standardDeviation, type BatteryRun } from '../../src/measure/report.js';
import { parseResult, RESULT_PREFIX } from '../../src/measure/result.js';

function run(seed: number, parts: readonly number[], agreementPct: number | null, startedAt = '2026-09-15T20:00:00.000Z'): BatteryRun {
  return {
    startedAt,
    sha: 'abc1234',
    dirty: false,
    seed,
    parts,
    full: true,
    measurements: {
      'validate:tavern': {
        exitCode: 0,
        durationSec: 600,
        result: { seed, parts, metrics: { turns: 380, agreementPct } },
      },
    },
  };
}

describe('строка итога замера', () => {
  it('читается последняя строка с префиксом среди обычного вывода', () => {
    const stdout = [
      '═══ part4 ═══',
      `${RESULT_PREFIX}{"seed":1,"parts":null,"metrics":{"turns":1}}`,
      'итог',
      `${RESULT_PREFIX}{"seed":1,"parts":null,"metrics":{"turns":2}}`,
    ].join('\r\n');
    expect(parseResult(stdout)?.metrics).toEqual({ turns: 2 });
  });

  it('нет строки — нет итога', () => {
    expect(parseResult('упал на середине')).toBeNull();
  });
});

describe('сравнение прогонов батареи', () => {
  it('сравнимы только прогоны с тем же зерном и теми же партиями', () => {
    expect(comparable(run(1, [4, 5], 74), run(1, [4, 5], 75))).toBe(true);
    expect(comparable(run(1, [4, 5], 74), run(2, [4, 5], 75))).toBe(false);
    expect(comparable(run(1, [4, 5], 74), run(1, [4, 5, 6], 75))).toBe(false);
  });

  it('полоса шума — SD метрики по зёрнам', () => {
    expect(standardDeviation([1])).toBeNull();
    expect(standardDeviation([2, 4])).toBeCloseTo(Math.SQRT2, 10);
    const band = noiseBand([run(1, [4], 74), run(2, [4], 76), run(3, [4], 75)]);
    expect(band?.sd['validate:tavern']?.agreementPct).toBeCloseTo(1, 10);
    // У числа ходов разброса нет — SD ноль, а не пропуск.
    expect(band?.sd['validate:tavern']?.turns).toBe(0);
  });

  it('таблица называет дельту и судит её по полосе шума', () => {
    const band = noiseBand([run(1, [4], 74), run(2, [4], 76)]);
    const table = renderMarkdown(run(1, [4], 78), run(1, [4], 74, '2026-09-14T20:00:00.000Z'), band);
    expect(table).toContain('| agreementPct | 74 | 78 | 4 | 1.414 | ВНЕ шума |');
    expect(table).toContain('| turns | 380 | 380 | 0 | 0 | без изменений |');
  });

  it('тысячные не теряются: Brier 0.003 остаётся 0.003, а не 0', () => {
    const tiny = { ...run(1, [4], 74), measurements: { calibrate: { exitCode: 0, durationSec: 34, result: { seed: 1, parts: null, metrics: { brier: 0.003 } } } } };
    const table = renderMarkdown(tiny, null, null);
    expect(table).toContain('| brier | — | 0.003 |');
    expect(table).toContain('## calibrate · 34 с');
  });

  it('прогон на подмножестве не выдаёт себя за полный', () => {
    const quick = { ...run(1, [4], 74), full: false };
    expect(renderMarkdown(quick, null, null)).toContain('Прогон на подмножестве партий');
    expect(renderMarkdown(run(1, [4], 74), null, null)).toContain('Последний полный прогон');
  });

  it('без прошлого прогона таблица об этом говорит, а не рисует нули', () => {
    const table = renderMarkdown(run(1, [4], 78), null, null);
    expect(table).toContain('Сравнимого прошлого прогона нет');
    expect(table).toContain('| agreementPct | — | 78 | — |');
  });
});
