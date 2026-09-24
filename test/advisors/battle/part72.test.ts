import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodesAsync, type BattleEpisode } from '../../../src/advisors/battle/episodes.js';
import { toBattleInfo } from '../../../src/advisors/battle/mapper.js';
import { seededSimulator } from '../../../src/advisors/battle/seeded.js';
import { sharedBattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { loadFieldBoards } from '../../../src/advisors/strength/boards.js';
import { fieldStrength } from '../../../src/advisors/strength/strength.js';
import { playersAlive, type GameState } from '../../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../../src/ui/logSlice.js';
import { createBreather } from '../../breather.js';
import { part72Game } from '../../fixtures.js';

/**
 * part72 — Иллидан: что бой знает о силе героя и о потолке урона
 * (вопросы игрока 24.09 дословно: «учитывал ли ты силу героя?»
 * и «пишет смерть в 2 процентов таких ходов, хотя из-за блока урона
 * я не могу проиграть по факту»).
 *
 * Сила Wingmen `TB_BaconShop_HP_069` («Два крыла», сущность 182,
 * game.log:1388) уходит симулятору в `heroPowers`, и пакет её знает
 * (`soc-illidan-hero-power.js`: крайние левый и правый получают +2/+1
 * и бьют первыми). Потолок урона пакет тоже знает, но включается он
 * только числом живых и флагом `applyDamageCap` — их мы не передавали
 * (D288). Бой хода 18 (game.log, 19:45:50): запас 28 → 13, урон ровно 15.
 */
describe('part72: сила Иллидана и потолок урона в бою', () => {
  let episodes: BattleEpisode[];

  beforeAll(async () => {
    episodes = await readBattleEpisodesAsync(part72Game(), createBreather());
  }, 600_000);

  const at = (turn: number): BattleEpisode => {
    const found = episodes.find((e) => e.turn === turn);
    if (found === undefined) throw new Error(`нет боя на ходу ${String(turn)}`);
    return found;
  };

  it('сила Wingmen уходит симулятору в каждом бою партии', () => {
    expect(episodes.map((e) => e.turn)).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    for (const episode of episodes) {
      const powers = toBattleInfo(episode, 1).playerBoard.player.heroPowers.map((p) => p.cardId);
      expect(powers).toEqual(['TB_BaconShop_HP_069']);
    }
  });

  it('бой хода 14 выигран крыльями: с силой прогноз уверенный, без неё — монетка', () => {
    // Сверка 24.09 (2000 симуляций, зерно 1): 92 % побед с силой, 56 % без.
    // Бой выигран — прогноз с силой сошёлся, без неё был бы вдвое осторожнее.
    const simulator = seededSimulator(sharedBattleSimulator(), 1);
    const episode = at(14);
    expect(episode.outcome).toBe('won');
    const withPower = simulator.run(toBattleInfo(episode, 1000));
    const withoutPower = simulator.run(
      toBattleInfo({ ...episode, playerHero: { ...episode.playerHero, heroPowerCardId: null } }, 1000),
    );
    expect(withPower.wonPercent).toBeGreaterThanOrEqual(85);
    expect(withoutPower.wonPercent).toBeLessThanOrEqual(70);
  });

  it('число живых на начало каждого боя читается из лобби', () => {
    // До хода 18 живы все восемь; игрок 4 выбыл в бою хода 18
    // (DAMAGE 15 → 30 при HEALTH 30), дальше семеро.
    expect(episodes.map((e) => e.playersAlive)).toEqual([8, 8, 8, 8, 8, 8, 8, 8, 8, 7, 7]);
  });

  it('бой хода 18: с потолком урон поражения не выше 15 — ровно столько игрок и потерял', () => {
    const episode = at(18);
    expect(episode.outcome).toBe('lost');
    expect(episode.damageTaken).toBe(15);

    const simulator = seededSimulator(sharedBattleSimulator(), 1);
    const capped = simulator.run(toBattleInfo(episode, 1000));
    const uncapped = simulator.run(toBattleInfo({ ...episode, playersAlive: null }, 1000));
    // Без потолка пакет обещал в среднем 18.3 за поражение (сверка 24.09).
    expect(uncapped.damageLost / uncapped.lost).toBeGreaterThan(15);
    expect(capped.damageLost / capped.lost).toBeLessThanOrEqual(15);
  });
});

describe('part72, кадр 19:45: смерть против поля хода', () => {
  let state: GameState;

  beforeAll(() => {
    const clock = parseClock('19:45:42');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part72Game(), clock!);
    expect(slice?.inGame).toBe(true);
    state = frameAt(slice!).state;
  }, 600_000);

  it('кадр воспроизводится: ход 17, тир 5, запас 28, живы все восемь', () => {
    // Числа с картинки игрока: «ход 17 · таверна · тир 5 · золото 0/11 · hp 28».
    expect(state.turn).toBe(17);
    expect(state.techLevel).toBe(5);
    expect(state.gold).toBe(0);
    const hero = state.hero!;
    expect((hero.health ?? 0) - hero.damage + hero.armor).toBe(28);
    expect(playersAlive(state)).toBe(8);
  });

  it('потолок 15 не пробивает запас 28: смерти ноль, доля побед прежняя', () => {
    // До правки на экране стояло «смерть в 2 % этих боёв» (1.97 % в пересчёте
    // кадра) при тех же 32 % побед: потолок меняет урон, а не исход боя.
    const strength = fieldStrength(state, loadFieldBoards(), sharedBattleSimulator());
    expect(strength).not.toBeNull();
    expect(strength!.deathPercent).toBe(0);
    expect(strength!.percent).toBeGreaterThan(25);
    expect(strength!.percent).toBeLessThan(40);
  });
});
