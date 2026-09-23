import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodesAsync, type BattleEpisode } from '../../../src/advisors/battle/episodes.js';
import { toBattleInfo } from '../../../src/advisors/battle/mapper.js';
import { seededSimulator } from '../../../src/advisors/battle/seeded.js';
import { createBattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { createBreather } from '../../breather.js';
import { part71Game } from '../../fixtures.js';

/**
 * part71 — Drek'Thar: ход, который видит симулятор (жалоба игрока 24.09
 * «учитывал ли ты мою силу героя?»).
 *
 * Силу героя симулятор получает (`toPlayerEntity`), и Frostwolf Fervor он
 * знает: `summon-when-space.js` призывает копию сильнейшего по атаке при
 * `gameState.currentTurn >= 7`. Семёрка там — ход ТАВЕРНЫ, как в тексте
 * карты «Unlocks on Turn 7» и как в ограничителе урона того же пакета
 * (`damage-cap.js`: `< 4` → 5, `< 8` → 10). А мы передавали ход ПАРТИИ,
 * который считает и бой (D129), — и сила «отпиралась» в симуляторе на ходу
 * партии 7, то есть на ЧЕТВЁРТОМ ходу таверны вместо седьмого.
 *
 * В логе замок — тег `LOCK_VISUAL` на сущности силы: 1 с создания
 * (строка 1285), 0 на ходу партии 13 (строка 69059). Сработала сила только
 * в боях ходов 14, 16, 20 и 22 (первый блок `TRIGGER` — строка 84920).
 */
describe('part71: сила Drek’Thar в симуляторе боя', () => {
  let episodes: BattleEpisode[];

  beforeAll(async () => {
    episodes = await readBattleEpisodesAsync(part71Game(), createBreather());
  }, 600_000);

  const at = (turn: number): BattleEpisode => {
    const found = episodes.find((e) => e.turn === turn);
    if (found === undefined) throw new Error(`нет боя на ходу ${String(turn)}`);
    return found;
  };

  it('порог силы в симуляторе совпадает с замком силы в логе на каждом бою', () => {
    expect(episodes.map((e) => e.turn)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    for (const episode of episodes) {
      expect(episode.playerHero.heroPowerCardId).toBe('BG22_HERO_002p');
      const unlockedInSimulator = toBattleInfo(episode, 1).gameState.currentTurn >= 7;
      expect({ turn: episode.turn, unlocked: unlockedInSimulator }).toEqual({
        turn: episode.turn,
        unlocked: !episode.playerHero.heroPowerLocked,
      });
    }
  });

  it('запертая сила не меняет прогноз: бой хода 10 (таверна 5) считается как без силы', () => {
    // До правки: 71 % побед с силой против 10 % без неё — симулятор ставил
    // на стол копию, которой в бою не было (бой выигран без неё, блока
    // `TRIGGER` силы на ходу 10 в логе нет).
    const simulator = seededSimulator(createBattleSimulator(), 1);
    const episode = at(10);
    const withPower = simulator.run(toBattleInfo(episode, 1000));
    const withoutPower = simulator.run(
      toBattleInfo({ ...episode, playerHero: { ...episode.playerHero, heroPowerCardId: null } }, 1000),
    );
    expect(Math.abs(withPower.wonPercent - withoutPower.wonPercent)).toBeLessThan(10);
  });
});
