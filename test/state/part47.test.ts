import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, heroPowerUpgradeRule } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { part47Game } from '../fixtures.js';

/**
 * part47 — Галакронд (07.09.2026). Пункт игрока один, и он про ПОЛНОЕ
 * молчание: «на 1 скриншоте ты советовал улучшить таверну, но на данном
 * герое с его силой выгоднее нажимать силу героя и получать рано сильных
 * существ».
 *
 * Тест держит три разные вещи, и делить их важно: ФАКТУРУ лога (что сила
 * делает на самом деле), ЧТЕНИЕ (правило перестало быть немым) и ГРАНИЦЫ
 * (где оно молчит и почему). Числа советника закреплены не ради самих
 * чисел, а чтобы правка весов не проехала мимо этой ветки молча.
 */
describe('part47: сила героя, поднимающая карту витрины на тир', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part47Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  it('герой — Галакронд, сила активна с первого хода и не под замком', () => {
    const hero = decisionPoint(1).hero;
    expect(hero?.heroPowerCardId).toBe('TB_BaconShop_HP_011');
    expect(hero?.heroPowerCost).toBe(1);
    expect(hero?.heroPowerLocked).toBe(false);
    // Ровно то, из-за чего молчание было незаметным: по всем признакам,
    // которые правила читали, сила ДОСТУПНА — молчал разбор текста.
    expect(cards.info('TB_BaconShop_HP_011')?.text ?? '').toMatch(/higher Tier/i);
  });

  /**
   * Фактура механики — из лога, а не из текста карты. Игра пишет цель
   * полем `Target=` блока PLAY, и цель эта — миньон ВИТРИНЫ (`player=16`),
   * а не наш борд.
   */
  it('нажатий пять, и все пять целят в витрину', () => {
    const plays = text
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.includes('GameState.DebugPrintPower()') &&
          l.includes('BlockType=PLAY') &&
          l.includes('cardId=TB_BaconShop_HP_011'),
      );
    expect(plays).toHaveLength(5);
    for (const line of plays) {
      expect(line).toMatch(/Target=\[entityName=[^\]]*player=16\]/);
    }
  });

  /**
   * ЛЕСТНИЦА: каждое нажатие целит в карту, созданную предыдущим, и тир
   * растёт ровно на единицу. Это и есть довод игрока — за пять золотых
   * партия дошла от тира 1 до тира 6, — и это же граница нашего счёта:
   * одноходовая оценка меряет ОДНУ ступеньку.
   */
  it('лестница тиров: цели идут 1 → 2 → 3 → 4 → 5', () => {
    const targets = [...text.matchAll(/BlockType=PLAY [^\n]*cardId=TB_BaconShop_HP_011[^\n]*/g)]
      .map((m) => /Target=\[entityName=[^\]]*cardId=([A-Za-z0-9_]+) player=16\]/.exec(m[0])?.[1])
      .filter((id): id is string => id !== undefined);
    // Дубли двух каналов лога (`GameState` и `PowerTaskList`) сняты выше
    // фильтром по каналу, здесь берём уникальные по порядку.
    const tiers = targets.map((id) => cards.info(id)?.techLevel ?? null);
    expect(tiers.slice(0, 10)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  /**
   * Главное утверждение партии: правило перестало быть немым И называет
   * ту же цель, что выбрал игрок. На ходу 3 в витрине три карты первого
   * тира, поднять любую — одно и то же (тир цели один), и решает тай-брейк
   * «жальче меньше»: Ominous Seer собирается в тройку, Molten Rock — нет.
   * Игрок поднял Molten Rock (12:48:31).
   */
  it('ход 3: сила названа и целит в Molten Rock, как и сыграл игрок', () => {
    const state = decisionPoint(3);
    expect(state.gold).toBe(4);
    expect(state.techLevel).toBe(1);

    const rec = heroPowerUpgradeRule(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(rec).not.toBeNull();
    expect(rec?.action).toBe('heroPower');
    expect(rec?.cost).toBe(1);
    expect(cards.info(rec?.minion?.cardId ?? '')?.name).toBe('Molten Rock');
    expect(rec?.score ?? 0).toBeGreaterThan(0);

    // И в общем списке она теперь есть — прежде её не было ни в одной
    // из десяти точек решения партии.
    const all = adviseTavern(state, { cards })?.recommendations ?? [];
    expect(all.some((r) => r.action === 'heroPower')).toBe(true);
  });

  /**
   * Граница, которую нельзя терять: поднятая карта остаётся В ВИТРИНЕ,
   * и без покупки этот ход она не значит ничего — то же условие, что
   * у платного обновления (part18). Ход 1: три золотых, нажатие оставит
   * два, а дешевле трёх в витрине ничего нет.
   */
  it('ход 1 молчит: после нажатия покупать не на что', () => {
    const state = decisionPoint(1);
    expect(state.gold).toBe(3);
    expect(heroPowerUpgradeRule(state, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
  });

  /**
   * Вторая граница, и она — причина, по которой оценка считается
   * ПОКУПКАМИ, а не слотом. На ходу 7 шесть золотых покупают ДВА тела
   * по 18.5 (копии Ominous Seer под тройку), а нажатие оставляет пять,
   * то есть одно. Слотовая форма звала бы жать и теряла бы 18.5.
   */
  it('ход 7 молчит: нажатие стоило бы целой покупки', () => {
    const state = decisionPoint(7);
    expect(state.gold).toBe(6);
    expect(heroPowerUpgradeRule(state, { cards }, DEFAULT_TAVERN_RULES)).toBeNull();
  });

  /**
   * План после нажатия ОБРЫВАЕТСЯ: что предложит выбор из трёх, решает
   * игра. Золото обещанной покупки при этом списано (`refreshSpend`) —
   * иначе очки нажатия, уже посчитанные покупками хода, план потратил бы
   * второй раз.
   */
  it('ход 17: нажатие входит в план и обрывает его', () => {
    const state = decisionPoint(17);
    const plan = spendPlan(state, { cards });
    const step = plan.steps.findIndex((s) => s.recommendation.action === 'heroPower');
    expect(step).toBeGreaterThanOrEqual(0);
    expect(step).toBe(plan.steps.length - 1);
  });

  /**
   * Сколько правило говорит за партию — закреплено числом, потому что
   * молчание тут и было дефектом. Пять точек из десяти, и на трёх из них
   * цель совпадает с фактическим нажатием игрока (ходы 3, 9, 11).
   */
  it('за партию правило говорит в пяти точках решения из десяти', () => {
    expect(turns).toHaveLength(10);
    const fired = turns.filter(
      ({ state }) => heroPowerUpgradeRule(state, { cards }, DEFAULT_TAVERN_RULES) !== null,
    );
    expect(fired.map((t) => t.turn)).toEqual([3, 9, 11, 15, 17]);
  });
});
