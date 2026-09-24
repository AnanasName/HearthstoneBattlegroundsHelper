import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodesAsync, type BattleEpisode } from '../../../src/advisors/battle/episodes.js';
import { toBattleInfo } from '../../../src/advisors/battle/mapper.js';
import { seededSimulator } from '../../../src/advisors/battle/seeded.js';
import { sharedBattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { createBreather } from '../../breather.js';
import { part73Game } from '../../fixtures.js';

/**
 * part73 — Ониксия: что бой знает о дракончиках силы (вопрос игрока 24.09
 * дословно: «Учитывал ли ты силу героя?»).
 *
 * Сила Broodmother `BG22_HERO_305p` уходила симулятору, но РАЗМЕРОМ НОЛЬ:
 * пакет берёт статы дракончика из `heroPower.info` (avenge.js, ветка
 * `BG22_HERO_305p`), а маппер клал туда 0 у любой силы. Дракончик 0/0
 * умирал, не успев ударить, — месть работала вхолостую. Размер лежит
 * в логе тегом `TAG_SCRIPT_DATA_NUM_1` на сущности силы (game.log:1522 —
 * 1 с создания; 30435 — 2 после первого призыва в бою хода 8) и уже
 * читается в `hero.heroPowerScriptData[0]`.
 */
describe('part73: дракончик Broodmother в бою', () => {
  let episodes: BattleEpisode[];

  beforeAll(async () => {
    episodes = await readBattleEpisodesAsync(part73Game(), createBreather());
  }, 600_000);

  const at = (turn: number): BattleEpisode => {
    const found = episodes.find((e) => e.turn === turn);
    if (found === undefined) throw new Error(`нет боя на ходу ${String(turn)}`);
    return found;
  };

  it('размер дракончика на начало каждого боя уходит симулятору', () => {
    // Размер на начало боя: растёт только в боях, где месть сработала
    // (ход 8 — раз, ход 10 — трижды, ход 12 — дважды…), game.log:30435…
    expect(episodes.map((e) => e.turn)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34]);
    const sizes = episodes.map((e) => {
      const [power] = toBattleInfo(e, 1).playerBoard.player.heroPowers;
      expect(power?.cardId).toBe('BG22_HERO_305p');
      return power?.info;
    });
    expect(sizes).toEqual([1, 1, 1, 1, 2, 5, 7, 9, 10, 13, 15, 15, 18, 22, 24, 28, 30]);
  });

  it('бой хода 14 выигран дракончиками 7/7: с размером прогноз уверенный, с нулём — проигрыш', () => {
    // Сверка 24.09 (1000 симуляций, зерно 1): 77 % побед с размером 7,
    // 27 % с размером 0. Бой выигран.
    const simulator = seededSimulator(sharedBattleSimulator(), 1);
    const episode = at(14);
    expect(episode.outcome).toBe('won');
    const withWhelps = simulator.run(toBattleInfo(episode, 1000));
    const zeroWhelps = simulator.run(
      toBattleInfo(
        { ...episode, playerHero: { ...episode.playerHero, heroPowerScriptData: [0] } },
        1000,
      ),
    );
    expect(withWhelps.wonPercent).toBeGreaterThanOrEqual(65);
    expect(zeroWhelps.wonPercent).toBeLessThanOrEqual(40);
  });
});
