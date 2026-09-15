import { describe, expect, it } from 'vitest';

import { clockText, logClockSeconds, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';

describe('часы кадра', () => {
  it('минуты без секунд — это вся минута', () => {
    expect(parseClock('13:53')).toEqual({ seconds: 13 * 3600 + 53 * 60, precise: false });
    expect(parseClock('13:53:59')).toEqual({ seconds: 13 * 3600 + 53 * 60 + 59, precise: true });
    expect(parseClock('9:05')).toEqual({ seconds: 9 * 3600 + 5 * 60, precise: false });
  });

  it('невозможные часы не разбираются', () => {
    expect(parseClock('25:00')).toBeNull();
    expect(parseClock('13:60')).toBeNull();
    expect(parseClock('полдень')).toBeNull();
  });

  it('метка строки лога читается с дробной частью', () => {
    expect(logClockSeconds('13:53:59.7412345')).toBeCloseTo(13 * 3600 + 53 * 60 + 59.7412345, 6);
    expect(clockText(13 * 3600 + 53 * 60 + 59.74)).toBe('13:53:59');
  });
});

describe('срез по часам', () => {
  // Партия через полночь: строкой «00:00» меньше «23:58», и срез
  // сравнением строк оборвался бы на первой же строке.
  const log = [
    'D 23:58:10.0000000 GameState.DebugPrintPower() - A',
    '    продолжение без метки',
    'D 23:59:30.0000000 GameState.DebugPrintPower() - B',
    'D 00:00:15.0000000 GameState.DebugPrintPower() - C',
    'D 00:01:05.0000000 GameState.DebugPrintPower() - D',
  ].join('\n');

  it('кадр после полуночи режется по сквозной шкале', () => {
    const slice = sliceLogByClock(log, parseClock('00:00')!);
    expect(slice).not.toBeNull();
    expect(slice!.inGame).toBe(true);
    expect(slice!.text.split('\n')).toHaveLength(4);
    expect(slice!.text).toContain(' - C');
    expect(slice!.text).not.toContain(' - D');
  });

  it('с секундами кадр кончается на названной секунде', () => {
    const slice = sliceLogByClock(log, parseClock('23:59:30')!);
    expect(slice!.text).toContain(' - B');
    expect(slice!.text).not.toContain(' - C');
    expect(clockText(slice!.frameStart)).toBe('23:59:00');
  });

  it('строка без метки идёт вместе с предыдущей', () => {
    const slice = sliceLogByClock(log, parseClock('23:58:10')!);
    expect(slice!.text).toContain('продолжение без метки');
  });

  it('кадр вне партии так и называется', () => {
    expect(sliceLogByClock(log, parseClock('13:00')!)!.inGame).toBe(false);
  });

  it('лог без меток не режется', () => {
    expect(sliceLogByClock('ничего\nсовсем', parseClock('13:00')!)).toBeNull();
  });
});
