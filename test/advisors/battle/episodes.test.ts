import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodesAsync, type BattleEpisode } from '../../../src/advisors/battle/episodes.js';
import { createBreather } from '../../breather.js';
import { part4Game } from '../../fixtures.js';

/**
 * Последний бой проигранной партии (долг part52).
 *
 * Бой закрывается возвратом стола в таверну — `BOARD_VISUAL_STATE=1`.
 * У победителя он приходит и после финального боя (part34, part42, part50:
 * строка возврата стоит перед `PLAYSTATE value=WON`), а у выбывшего его
 * нет вовсе: part4 кончается так —
 *
 *   00:29:29 TAG_CHANGE Entity=GameEntity tag=BOARD_VISUAL_STATE value=2
 *   00:29:30 TAG_CHANGE Entity=AngryMem#2886 tag=PLAYSTATE value=LOST
 *   00:29:31 TAG_CHANGE Entity=GameEntity tag=STEP value=FINAL_GAMEOVER
 *
 * и бой хода 18, выбивший игрока, в калибровку не попадал. Терялся ровно
 * решающий бой каждой партии, кроме взятых первым местом.
 */
describe('бои партии: последний бой выбывшего игрока', () => {
  let episodes: BattleEpisode[];

  beforeAll(async () => {
    episodes = await readBattleEpisodesAsync(part4Game(), createBreather());
  }, 120_000);

  it('бой, выбивший игрока, собран с исходом «проигрыш»', () => {
    const last = episodes[episodes.length - 1];
    expect(last?.turn).toBe(18);
    expect(last?.outcome).toBe('lost');
    // Перед боем у героя оставалось 6 (30 здоровья, 24 урона, брони нет):
    // бой, кончивший партию, снял не меньше.
    expect(last?.damageTaken).toBeGreaterThanOrEqual(6);
    expect(last?.opponentBoard.length).toBeGreaterThan(0);
  });

  it('прочие бои не задвоены и идут через ход', () => {
    expect(episodes.map((e) => e.turn)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
  });
});
