import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodesAsync, type BattleEpisode } from '../../src/advisors/battle/episodes.js';
import { toBattleInfo } from '../../src/advisors/battle/mapper.js';
import { createBreather } from '../breather.js';
import { part53Game } from '../fixtures.js';

/**
 * Надбавка к жукам — `TAG_SCRIPT_DATA_NUM_1/2` на «Beetle Army Player
 * Enchant» `BG31_808pe` (смысл назвал игрок 17.09: общее усиление, которое
 * получит каждый следующий призванный жук).
 *
 * Лог part53 подтверждает смысл числом: жук `BG28_603t` рождается 2/2
 * и сразу получает ровно надбавку своего контроллера (все девять жуков
 * партии: 99/97 → 101/99, 104/102 → 106/104 …), а Ravaging Scorpid растит
 * её прямо в бою — у соперника `E20153` 134/132 → 139/137 → 144/142
 * (строки 412385, 413221, 415341), и живые жуки растут вместе с ней.
 * Этот рост симулятор считает сам (`ravaging-scorpid.js`); ему нужно
 * число на НАЧАЛО боя — `BeetleAttackBuff`/`BeetleHealthBuff`.
 *
 * Бой хода 26 — единственный в корпусе, где надбавка есть у ОБЕИХ сторон
 * (6/3 у нас, 89/87 у соперника): на нём и видно, что стороны не смешаны.
 */
describe('part53: жучиная надбавка обеих сторон боя', () => {
  let episodes: BattleEpisode[];

  beforeAll(async () => {
    episodes = await readBattleEpisodesAsync(part53Game(), createBreather());
  }, 300_000);

  const on = (turn: number): BattleEpisode => {
    const found = episodes.find((e) => e.turn === turn);
    expect(found, `бой хода ${String(turn)}`).toBeDefined();
    return found!;
  };

  it('ход 26: своя 6/3 и чужая 89/87 читаются порознь', () => {
    const e = on(26);
    expect([e.globalInfo.beetleAttackBuff, e.globalInfo.beetleHealthBuff]).toEqual([6, 3]);
    expect([e.opponentGlobalInfo.beetleAttackBuff, e.opponentGlobalInfo.beetleHealthBuff]).toEqual([89, 87]);
  });

  it('до первого жука надбавки нет вовсе, а не ноль', () => {
    const e = on(2);
    expect(e.globalInfo.beetleAttackBuff).toBeNull();
    expect(e.opponentGlobalInfo.beetleAttackBuff).toBeNull();
  });

  it('обе надбавки уезжают в симулятор именами пакета', () => {
    const info = toBattleInfo(on(26), 1);
    const own = info.playerBoard.player.globalInfo as Record<string, number>;
    const theirs = info.opponentBoard.player.globalInfo as Record<string, number>;
    expect([own['BeetleAttackBuff'], own['BeetleHealthBuff']]).toEqual([6, 3]);
    expect([theirs['BeetleAttackBuff'], theirs['BeetleHealthBuff']]).toEqual([89, 87]);
  });
});
