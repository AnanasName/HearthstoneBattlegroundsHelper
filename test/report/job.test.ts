import { describe, expect, it } from 'vitest';

import { createGameOverWatch, sessionDateOf, sessionRefOf } from '../../src/report/job.js';

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

describe('отчёт после партии: когда собирать', () => {
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

  it('имя и дата отчёта — из имени сессии логов', () => {
    const path = 'C:/data/games/Hearthstone_2026_09_24_19_26_35.Power.log.part';
    expect(sessionRefOf(path)).toBe('Hearthstone_2026_09_24_19_26_35');
    expect(sessionDateOf(path)).toBe('2026-09-24');
    expect(sessionDateOf('C:/tmp/game.log')).toBeNull();
  });
});
