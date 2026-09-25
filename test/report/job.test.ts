import { describe, expect, it } from 'vitest';

import {
  createGameOverWatch,
  gameByteRanges,
  pickGame,
  sessionDateOf,
  sessionRefOf,
} from '../../src/report/job.js';

/**
 * Приложение собирает разбор само, когда в дописанных байтах лога
 * появляется конец партии. Строка — канала-источника, на верхнем уровне:
 * part72:228011 `D 19:50:48.7832662 GameState.DebugPrintPower() -
 * TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER`. Строка
 * `NEXT_STEP value=FINAL_GAMEOVER` (part72:227998) приходит раньше и концом
 * партии не является, как и её дубль канала `PowerTaskList` (part72:238346).
 */
const OVER =
  'D 19:50:48.7832662 GameState.DebugPrintPower() - TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER \r\n';
const NEXT_STEP =
  'D 19:50:48.5032304 GameState.DebugPrintPower() -     TAG_CHANGE Entity=GameEntity tag=NEXT_STEP value=FINAL_GAMEOVER \r\n';
const TASK_LIST =
  'D 19:51:26.2108351 PowerTaskList.DebugPrintPower() -     TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER \r\n';

/** Сессия клиента из нескольких партий: начало — строка `CREATE_GAME` канала-источника, режим — `GameType` (part72:240). */
function game(start: string, type: string, finished: boolean): string {
  return [
    `D ${start}.0000000 GameState.DebugPrintPower() - CREATE_GAME`,
    `D ${start}.0000000 GameState.DebugPrintGame() - GameType=${type}`,
    `D ${start}.1000000 PowerTaskList.DebugPrintPower() - CREATE_GAME`,
    ...(finished ? [`D ${start}.9000000 GameState.DebugPrintPower() - TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER`] : []),
    '',
  ].join('\r\n');
}

describe('отчёт после партии: когда собирать и что', () => {
  it('ловит конец партии канала-источника и ничего до него', () => {
    const watch = createGameOverWatch();
    expect(watch.push(Buffer.from(NEXT_STEP))).toBe(false);
    expect(watch.push(Buffer.from(TASK_LIST))).toBe(false);
    expect(watch.push(Buffer.from(OVER))).toBe(true);
  });

  it('строка, разрезанная границей порции, ловится один раз', () => {
    const watch = createGameOverWatch();
    const cut = 70;
    expect(watch.push(Buffer.from(OVER.slice(0, cut)))).toBe(false);
    expect(watch.push(Buffer.from(OVER.slice(cut)))).toBe(true);
    // Та же строка не срабатывает второй раз из хвоста прошлой порции.
    expect(watch.push(Buffer.from('D 19:50:49.0000000 GameState.DebugPrintPower() - x\r\n'))).toBe(false);
  });

  it('партии режутся по байтам: только строка канала-источника начинает партию, дубль показа — нет', () => {
    const bytes = Buffer.from(game('10:00:00', 'GT_BATTLEGROUNDS', true) + game('10:30:00', 'GT_BATTLEGROUNDS', true));
    const ranges = gameByteRanges(bytes);
    expect(ranges.map((r) => r.index)).toEqual([1, 2]);
    expect(bytes.toString('utf8', ranges[1]?.from, ranges[1]?.to).startsWith('D 10:30:00')).toBe(true);
  });

  it('берётся последняя доигранная партия Battlegrounds, а не рейтинговая после неё; номер партии стабилен', () => {
    const one = Buffer.from(game('10:00:00', 'GT_BATTLEGROUNDS', true));
    const three = Buffer.from(
      game('10:00:00', 'GT_BATTLEGROUNDS', true) + game('10:30:00', 'GT_RANKED', true) + game('11:00:00', 'GT_BATTLEGROUNDS', false),
    );
    expect(pickGame(one)?.index).toBe(1);
    // Номер от последующих партий не меняется: имя отчёта той же партии одно.
    expect(pickGame(three)?.index).toBe(1);
    expect(pickGame(three, 3)?.passport.finished).toBe(false);
    expect(pickGame(Buffer.from(game('10:30:00', 'GT_RANKED', true)))).toBeNull();
  });

  it('имя и дата отчёта — из имени сессии; партия после полуночи — следующим числом', () => {
    const path = 'C:/data/games/Hearthstone_2026_09_24_23_05_00.Power.log.part';
    expect(sessionRefOf(path)).toBe('Hearthstone_2026_09_24_23_05_00');
    expect(sessionDateOf(path)).toBe('2026-09-24');
    expect(sessionDateOf(path, '23:10:00')).toBe('2026-09-24');
    expect(sessionDateOf(path, '00:40:00')).toBe('2026-09-25');
    expect(sessionDateOf('C:/tmp/game.log')).toBeNull();
  });
});
