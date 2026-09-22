import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, freezeRule, levelUpRule } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part70Game } from '../fixtures.js';

/**
 * part70 — Синдрагоса (23.09.2026), 4-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Партия заведена ради силы
 * `TB_BaconShop_HP_014` «Stay Frosty», названной в `docs/deferred.md`
 * первым кандидатом на внесение, «когда появится фактура».
 *
 * Сила обещает три вещи, и советник читал из них полторы. Здесь
 * закреплены все три — и то, что читалось верно, тоже: без этого нельзя
 * ответить игроку на вопрос «учитывал ли ты силу героя», не гадая.
 */
describe('part70: Синдрагоса — что советник берёт из пассивной силы', () => {
  let cards: CardIndex;
  let turns: TavernTurn[];

  beforeAll(async () => {
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(part70Game(), createBreather());
  }, 600_000);

  const at = (turn: number): TavernTurn => {
    const found = turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`нет точки решения на ходу ${String(turn)}`);
    return found;
  };

  const deps = (): { cards: CardIndex } => ({ cards });

  it('сила героя — пассивная «Stay Frosty», и за партию она не нажата ни разу', () => {
    const first = at(1).state;
    expect(first.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_014');
    // Пассивная: цена силы — тег `COST` на её сущности, у нажимаемых он есть.
    expect(first.hero?.heroPowerCost).toBeNull();

    const text = cards.info('TB_BaconShop_HP_014')?.text ?? '';
    expect(text).toContain('Minions cost (2)');
    expect(text).toContain('one fewer minion');
    // Разметка внутри фразы — та самая причина, по которой шаблоны пишутся
    // с `[^.]*`, а не по словам подряд: в снапшоте стоит
    // «and <b><b>Freeze</b>s</b> at the end of each turn».
    expect(text).toMatch(/Freeze[^.]*at the end of each turn/i);

    const last = turns.at(-1)?.state;
    expect(last?.actions.filter((a) => a.type === 'heroPower')).toHaveLength(0);
  });

  it('цена покупки — 2 у каждого миньона каждой витрины, и она живая', () => {
    expect(turns).toHaveLength(11);
    for (const { state } of turns) {
      expect(state.shop.length).toBeGreaterThan(0);
      for (const m of state.shop) expect(m.buyCost).toBe(2);
    }
  });

  /**
   * «The Tavern offers one fewer minion» — не догадка, а счёт по всем
   * одиннадцати точкам: 2 миньона на тире 1 при табличных 3, 3 на тирах
   * 2–3 при 4, 4 на тирах 4–5 при 5.
   */
  it('витрина на каждом тире ровно на одного меньше таблицы', () => {
    for (const { state } of turns) {
      const byTable = DEFAULT_TAVERN_RULES.shopSizeByTier[state.techLevel] ?? 0;
      expect(state.shop).toHaveLength(byTable - 1);
    }
  });

  /**
   * Ход 3 (второй ход таверны), тир 1, золото 4 из 4: советник ставит
   * подъём первым и обещает витрину «до 4». На этом герое она расширится
   * до 3 — таблица `shopSizeByTier` написана для обычной таверны, а живая
   * витрина тут же, в состоянии, и врать ей незачем.
   */
  it('обещание при подъёме считается от ЖИВОЙ витрины, а не от таблицы', () => {
    const { state } = at(3);
    expect(state.techLevel).toBe(1);
    expect(state.shop).toHaveLength(2);

    const level = levelUpRule(state, DEFAULT_TAVERN_RULES);
    expect(level).not.toBeNull();
    expect(level?.reason).toContain('витрина расширится до 3');
    expect(level?.reason).not.toContain('витрина расширится до 4');
  });

  /**
   * Ход 1: витрина из двух тел, золота 3, и до правки советник вписывал
   * в план «ЗАМОРОЗИТЬ Recruit a Trainee — два тела вместо одного».
   *
   * Совет пустой: таверна этого героя морозится сама в конце КАЖДОГО хода.
   * В логе это блок TRIGGER на сущности силы (`TriggerKeyword=2882`),
   * 11 срабатываний на 11 ходов таверны, включая ход без единой покупки:
   * `FROZEN value=1` на каждом оставшемся миньоне витрины (game.log:5960,
   * 25133–25136) — и тем же блоком, на смене хода, `FROZEN value=0`
   * (game.log:6069). Заморозка живёт ровно между ходами и до точки решения
   * не доживает.
   *
   * Поэтому сторож `state.shop.every((m) => m.frozen)` внутри правила
   * не срабатывает никогда, хотя витрина хода 9 дословно равна витрине
   * хода 7, где игрок только поднял таверну и не купил ничего.
   */
  it('признака frozen в точке решения нет, хотя витрина переживает ход', () => {
    for (const { state } of turns) {
      expect(state.shop.every((m) => m.frozen)).toBe(false);
    }

    const ids = (turn: number): string[] => at(turn).state.shop.map((m) => m.cardId).sort();
    expect(ids(9)).toEqual(ids(7));
  });

  it('заморозка не советуется, когда таверна морозит витрину сама', () => {
    for (const turn of turns) {
      expect(freezeRule(turn.state, deps(), DEFAULT_TAVERN_RULES)).toBeNull();
    }
  });

  /**
   * Вторая жалоба игрока: «на 2 ходе ты предложил улучшить таверну, но
   * я сделал ход лучше с покупкой двух существ, ведь на следующий ход
   * у меня будет 5 золота и не факт, что я смогу их потратить».
   *
   * Он прав арифметикой. Подъём стоит 4 из 4, то есть весь ход; назавтра
   * он стоит уже 3 при пяти золотых — «подъём плюс покупка» тратит в ноль,
   * тогда как линия советника даёт на том же ходу две покупки и сгоревшую
   * монету. Через ход обе линии на тире 2, но у игрока на борде на тело
   * больше.
   *
   * Правило (D284) просит ВСЮ витрину, и эту границу выбрал корпус:
   * версия «просто два тела без сдачи» сдвигала part38 (ход 7) в сторону
   * ОТ человека, а там цены такие же дешёвые — [2,2,2,2], — но берутся
   * два тела из четырёх, а здесь оба из двух.
   */
  it('ход 3: план — купить всю витрину, а не поднять таверну', () => {
    const { state } = at(3);
    expect(state.techLevel).toBe(1);
    expect(state.gold).toBe(4);
    expect(state.tavernUpgradeCost).toBe(4);
    expect(state.shop.map((m) => m.buyCost)).toEqual([2, 2]);

    const plan = spendPlan(state, deps(), DEFAULT_TAVERN_RULES);
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['buy', 'buy']);
    expect(plan.goldLeft).toBe(0);

    // Список при этом не меняется: он ранжирует ОТДЕЛЬНЫЕ действия, и там
    // подъём честно стоит выше лучшей покупки (D043). Расходятся они
    // намеренно, и план — это то, что игрок делает ходом.
    const advice = adviseTavern(state, deps(), DEFAULT_TAVERN_RULES);
    expect(advice?.recommendations[0]?.action).toBe('levelUp');
  });

  /**
   * Граница правила, снятая с корпуса: на ходу 5 витрина тоже по 2, но
   * подъём стоит 3 из 5 — то есть золото хода он НЕ съедает, и развилка
   * тут ни при чём. Игрок на этом ходу поднялся, и план поднимается тоже.
   */
  it('ход 5: подъём не съедает ход целиком — план поднимается, как и игрок', () => {
    const { state } = at(5);
    expect(state.gold).toBe(5);
    expect(state.tavernUpgradeCost).toBe(3);

    const plan = spendPlan(state, deps(), DEFAULT_TAVERN_RULES);
    expect(plan.steps[0]?.recommendation.action).toBe('levelUp');

    const last = turns.at(-1)?.state;
    const turn5 = last?.actions.filter((a) => a.turn === 5) ?? [];
    expect(turn5.some((a) => a.type === 'levelUp')).toBe(true);
  });

  /**
   * Жалоба видна не в списке советов, а в ПЛАНЕ хода: до правки план хода 1
   * читался «КУПИТЬ Tusked Camper 2/3 за 2 → ЗАМОРОЗИТЬ Recruit a Trainee
   * — два тела вместо одного». Заморозка там второй шаг, на остатке в одно
   * золото, поэтому в самой точке решения правило её и не предлагало.
   *
   * Контроль — тот же кадр с вычеркнутой силой: шаг возвращается, то есть
   * убрала его именно сила, а не что-то ещё в состоянии.
   */
  it('пустой шаг заморозки уходит из плана хода 1, и уходит именно из-за силы', () => {
    const { state } = at(1);
    const hasFreeze = (s: GameState): boolean =>
      spendPlan(s, deps(), DEFAULT_TAVERN_RULES).steps.some(
        (step) => step.recommendation.action === 'freeze',
      );

    expect(hasFreeze(state)).toBe(false);

    const hero = state.hero;
    expect(hero).not.toBeNull();
    const withoutPower: GameState = {
      ...state,
      hero: hero === null ? null : { ...hero, heroPowerCardId: null },
    };
    expect(hasFreeze(withoutPower)).toBe(true);
  });
});
