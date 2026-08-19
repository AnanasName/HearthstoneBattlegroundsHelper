import { beforeAll, describe, expect, it } from 'vitest';

import {
  activationRules,
  adviseTavern,
  darkGiftRule,
  freezeRule,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES, tavernTurnOf } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part24Game } from '../fixtures.js';

/**
 * part24 — шестнадцатая партия с оверлеем (17.08.2026, Тесс Златопряха,
 * демоны, 5-е место). Четыре пункта обратной связи; здесь же игрок прислал
 * таблицу тиров тёмного дара, которой не хватало с part23.
 *
 * Контрольные значения — `part24.expected.json`.
 */
describe('part24: тиры дара, золото в плане, поглощение витрины', () => {
  let cards: CardIndex;

  let turn1: GameState | null = null;
  let turn3AfterUpgrade: GameState | null = null;
  let turn7: GameState | null = null;
  let turn9: GameState | null = null;
  let turn15BeforeActivate: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part24Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Ход 1, точка решения: три золота, витрина полна, в ней заклинание.
      if (s.turn === 1 && s.gold === 3 && s.board.length === 0) turn1 = s;

      // Ход 3 после подъёма: таверна 2, золото потрачено, витрина ещё старая.
      if (s.turn === 3 && s.gold === 0 && s.techLevel === 2) turn3AfterUpgrade = s;

      // Ход 7, точка решения: шесть золота, подъём стоит 5.
      if (s.turn === 7 && s.gold === 6 && s.board.length === 2) turn7 = s;

      // Ход 9, момент скриншота: два золота, в руке заклинание на золото.
      if (
        s.turn === 9 &&
        s.gold === 2 &&
        s.board.length === 6 &&
        s.handSpells.some((x) => x.cardId === 'BG28_571')
      ) {
        turn9 = s;
      }

      // Ход 15, момент скриншота: Тюремщик на борде и ЕЩЁ НЕ активирован.
      // Позже в том же ходу игрок его нажал — там совет обязан молчать.
      if (
        turn15BeforeActivate === null &&
        s.turn === 15 &&
        s.gold === 2 &&
        s.board.some((m) => m.cardId === 'BG36_503') &&
        !s.board.some((m) => m.cardId === 'BG36_503' && s.activatedEntityIds.includes(m.entityId))
      ) {
        turn15BeforeActivate = s;
      }
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 5-е место, герой из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(5);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_35_SKIN_E');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('все состояния скриншотов воспроизводятся из лога', () => {
    expect(turn1).not.toBeNull();
    expect(turn3AfterUpgrade).not.toBeNull();
    expect(turn7).not.toBeNull();
    expect(turn9).not.toBeNull();
    expect(turn15BeforeActivate).not.toBeNull();
  });

  /**
   * Пункт 4 (скриншот хода 15): «вместо полезной активации рекомендует
   * обновить таверну, что выглядит совсем проигрышным по статам».
   *
   * Soulkeeping Jailer: «Activate ({0}): Your Demons each consume a random
   * minion in the Tavern to gain its stats». Прежде такие эффекты были
   * отложены как «без прямой цены в статах». Цена читается вся: текст
   * называет ПЛЕМЯ едоков, борд даёт их ЧИСЛО, витрина — средние статы
   * съедаемого.
   */
  it('пункт 4: поглощение витрины считается числом и обходит обновление', () => {
    expect(turn15BeforeActivate).not.toBeNull();
    if (turn15BeforeActivate === null) return;

    const s = turn15BeforeActivate;
    expect(s.board.map((m) => m.cardId)).toContain('BG36_503');
    expect(cards.info('BG36_503')?.text).toContain('consume a random minion in the Tavern');

    const acts = activationRules(s, { cards });
    expect(acts).toHaveLength(1);
    const act = acts[0];
    expect(act?.minion?.cardId).toBe('BG36_503');
    expect(act?.cost).toBe(2);
    // Семь демонов, витрина из четырёх по ~24 стата: съедят четверых.
    expect(act?.score).toBeGreaterThan(40);
    expect(act?.reason).toContain('съедят витрину');

    // И это верхний совет, а не обновление витрины за 1.
    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('activate');
  });

  it('пункт 4: нажатая в этом ходу активация больше не советуется', () => {
    expect(turn15BeforeActivate).not.toBeNull();
    if (turn15BeforeActivate === null) return;

    const jailer = turn15BeforeActivate.board.find((m) => m.cardId === 'BG36_503');
    expect(jailer).toBeDefined();
    if (jailer === undefined) return;

    const after: GameState = {
      ...turn15BeforeActivate,
      activatedEntityIds: [...turn15BeforeActivate.activatedEntityIds, jailer.entityId],
    };
    expect(activationRules(after, { cards })).toHaveLength(0);
  });

  /**
   * Пункт 3 (скриншот хода 9): «зачем-то предлагает сначала применить
   * заклинание, которое даст золото, а потом купить другое, на которое итак
   * у меня уже хватает денег».
   *
   * Он смотрел на бессмыслицу: совет обещал «откроется покупка Ominous
   * Seer», а следующим шагом плана покупка НЕ открывалась. Причина —
   * гипотетическое состояние не получало обещанного золота: шаг считался
   * непрозрачным, хотя число написано в тексте карты.
   */
  it('пункт 3: золото от заклинания доходит до следующего шага плана', () => {
    expect(turn9).not.toBeNull();
    if (turn9 === null) return;

    expect(turn9.gold).toBe(2);
    const advice = adviseTavern(turn9, { cards });
    const coin = advice?.recommendations.find((r) => r.spellCardId === 'BG28_571');
    expect(coin?.grantsGold).toBe(1);
    expect(coin?.reason).toContain('откроется покупка');

    const plan = spendPlan(turn9, { cards });
    expect(plan.steps[0]?.recommendation.spellCardId).toBe('BG28_571');
    // Именно это и было сломано: после монетки золота становится три,
    // и следующий шаг стоит три, а не два.
    expect(plan.steps[0]?.goldAfter).toBe(3);
    expect(plan.steps[1]?.recommendation.cost).toBe(3);
    expect(plan.goldLeft).toBe(0);
  });

  /**
   * Таблица тиров тёмного дара — прислана игроком. До неё вес дара был
   * ПЛОСКИМ и вёл себя наоборот правде: обгонял покупку на втором тире
   * и проигрывал ей на пятом.
   */
  it('тёмный дар: тир предложения берётся из таблицы по ходу таверны', () => {
    expect(turn7).not.toBeNull();
    if (turn7 === null) return;

    // Наш ход 7 — четвёртый ход таверны: таблица обещает 2-й или 3-й тир.
    expect(tavernTurnOf(turn7.turn)).toBe(4);
    expect(DEFAULT_TAVERN_RULES.darkGift.tiersByTavernTurn[4]).toEqual([2, 3]);

    // На самом ходу 7 дар молчит по другой причине — золото уступается
    // доступному подъёму при отставании от графика (правило part8).
    // Таблицу это не проверяет, поэтому подъём из состояния убран.
    const noUpgrade: GameState = {
      ...turn7,
      tavernUpgradeCost: null,
      tavernUpgradeTarget: null,
    };
    const gift = darkGiftRule(noUpgrade, { cards });
    expect(gift?.reason).toContain('тир 2 или 3');
    // Оценка НИЖНЯЯ: сам дар и выбор из трёх сверху не считаются.
    expect(DEFAULT_TAVERN_RULES.darkGift.bonus).toBe(0);
  });

  /**
   * Пункт 1 (скриншот хода 3): «в ранней игре снова не советует заморозить
   * заклинание за 2, хотя раунд назад советовало».
   *
   * ПУНКТ НЕ ЗАКРЫТ — тест пришпиливает нынешнее поведение НАРОЧНО.
   *
   * Правка «свежая карта считается по тирам витрины, а не по одному своему»
   * планку опустила (10.4 → 9.79), но ценность заклинания — 8.5, и порога
   * оно по-прежнему не берёт. Опустить планку ещё — значит вернуть совет,
   * на который тот же игрок жаловался в part22 и part23. Ровно этот спор
   * уже стоил двух разворотов правила, и решать его должен он.
   */
  it('пункт 1 (НЕ ЗАКРЫТ): на первом тире заморозка есть, на втором нет', () => {
    expect(turn1).not.toBeNull();
    expect(turn3AfterUpgrade).not.toBeNull();
    if (turn1 === null || turn3AfterUpgrade === null) return;

    // Ход 1, таверна 1: заморозка советуется — план кончается ею.
    expect(turn1.techLevel).toBe(1);
    const plan1 = spendPlan(turn1, { cards });
    expect(plan1.steps[plan1.steps.length - 1]?.recommendation.spellCardId).toBe('BG28_504');

    // Ход 3, та же витрина и то же заклинание, но таверна уже 2 — молчание.
    expect(turn3AfterUpgrade.shopSpells.map((x) => x.cardId)).toEqual(['BG28_504']);
    expect(freezeRule(turn3AfterUpgrade, { cards })).toBeNull();
  });

  /**
   * Пункт 2 (скриншот хода 7): «предлагались демоны, которые хорошо
   * синергируют с картой на столе, и это ход без остатка по золоту, а софт
   * предлагал странный ход с улучшением таверны и сгоревшим золотом».
   *
   * ЗАКРЫТ 17.08 — решением игрока после ТРЕТЬЕЙ подряд жалобы на тот же
   * ход (part23 ход 5, part24 ход 7, part25 ход 7): «пусть план сравнивает
   * подъём с цепочкой». До этого правка писалась дважды и откатывалась:
   *  1) впустить подъём в развилку: сумма цепочек сокращает «лучшую
   *     покупку» и сводит вопрос к «срочность (3) против второй покупки
   *     (9–12)» — подъём проигрывает всегда, когда золота на два действия;
   *  2) вычесть сгоревший остаток из очков подъёма: `goldPointValue` (3)
   *     численно равен `levellingUrgencyPerTier` (3), поэтому один золотой
   *     съедал ровно один тир срочности.
   *
   * Принят первый путь — со снятым двойным счётом: в сумму цепочки подъём
   * идёт `standaloneScore` (одна срочность), а не очками списка. Следствие
   * названо игроку заранее и им принято: на шести золотых цепочка почти
   * всегда перевешивает один тир. СПИСОК советов при этом не изменился —
   * подъём в нём по-прежнему верхний.
   */
  it('пункт 2: план тратит шесть золотых на борд, а не на подъём с огарком', () => {
    expect(turn7).not.toBeNull();
    if (turn7 === null) return;

    expect(tavernTurnOf(turn7.turn)).toBe(4);
    expect(turn7.tavernUpgradeCost).toBe(5);

    // Список ранжирует отдельные действия — там подъём выше покупок.
    const advice = adviseTavern(turn7, { cards });
    expect(advice?.recommendations[0]?.action).toBe('levelUp');
    expect(advice?.recommendations[0]?.reason).toContain('сгорит');
    // Своя ценность подъёма — только срочность: лучшая покупка внутри очков
    // стоит ради места в списке и в сумму цепочки идти не может.
    expect(advice?.recommendations[0]?.standaloneScore).toBe(
      DEFAULT_TAVERN_RULES.levellingUrgencyPerTier,
    );

    // А план выбирает ход целиком — и подъёма в нём больше нет.
    const plan = spendPlan(turn7, { cards });
    expect(plan.steps.some((s) => s.recommendation.action === 'levelUp')).toBe(false);
    expect(plan.steps.some((s) => s.recommendation.action === 'buy')).toBe(true);
    // Игрок жаловался ровно на сгоревшее золото: было 2 из 7.
    expect(plan.goldLeft).toBeLessThan(2);
  });
});
