import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  choiceAdvice,
  freezeRule,
  isHandWorker,
  minionValue,
  playRules,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part22Game } from '../fixtures.js';
import { changesAdvisorState, MINION_STAT_MARKERS } from '../snapshots.js';

/**
 * part22 — четырнадцатая партия с оверлеем (17.08.2026, Грибомант Флургл,
 * мурлоки, 1-е место). Пять пунктов обратной связи, и три из них об одном:
 * РУКА — ЭТО ПОЗИЦИЯ, а не склад тел, которые надо поскорее выставить.
 *
 * Контрольные значения — `part22.expected.json`.
 */
describe('part22: рука как позиция, сила героя, удвоитель механики', () => {
  let cards: CardIndex;

  let turn1: GameState | null = null;
  let turn5Decision: GameState | null = null;
  let turn5Screenshot: GameState | null = null;
  let turn7: GameState | null = null;
  let turn17End: GameState | null = null;
  let turn23Choice: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part22Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      // Снимок состояния стоит девяти проходов по карте сущностей, а событий
      // в логе под двести тысяч: снимаем только там, где менялось что-то
      // из читаемого селекторами (тот же приём, что в part18 и part19).
      // Здесь к зонам и ресурсам добавлен канал ВЫБОРОВ — без него не виден
      // `openChoice` хода 23.
      const { content } = event.line;
      // Статы: селектор конца хода 17 ловит счетовода в руке на 208/206.
      if (!changesAdvisorState(content, MINION_STAT_MARKERS)) continue;
      const s = reducer.snapshot();

      // Выбор «Выберите одно» на ходу 23 — ровно эти три мурлока. Проверять
      // по одному варианту нельзя: Breakout Mastermind встречается и в более
      // позднем выборе, и селектор ловил чужой экран.
      if (
        s.openChoice !== null &&
        s.openChoice.options.length === 3 &&
        [...s.openChoice.options]
          .map((o) => o.cardId)
          .sort()
          .join(',') === 'BG35_142,BG35_143,BG36_507'
      ) {
        turn23Choice = s;
      }

      if (s.phase !== 'tavern') continue;

      // Точка решения хода 1: три золота, борд пуст, витрина полна.
      if (s.turn === 1 && s.gold === 3 && s.board.length === 0 && s.shop.length === 3) turn1 = s;

      // Точка решения хода 5: пять золота, разведчик ещё в витрине.
      if (s.turn === 5 && s.gold === 5 && s.board.length === 1 && s.shop.length === 4) {
        turn5Decision = s;
      }

      // Момент скриншота хода 5: две покупки сделаны, Flighty Scout в руке.
      if (s.turn === 5 && s.gold === 0 && s.board.length === 2 && s.hand.length === 1) {
        turn5Screenshot = s;
      }

      // Точка решения хода 7: шесть золота, борд из двух зверей.
      if (s.turn === 7 && s.gold === 6 && s.board.length === 2) turn7 = s;

      // Конец хода 17 (скриншот): полный борд, счетовод в руке уже 208/206.
      if (
        s.turn === 17 &&
        s.board.length === 7 &&
        s.hand.some((m) => m.cardId === 'BG26_137' && m.attack === 208)
      ) {
        turn17End = s;
      }
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 1-е место, герой и его сила из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(1);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_55');
    expect(finalState.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_056');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('все состояния скриншотов воспроизводятся из лога', () => {
    expect(turn1).not.toBeNull();
    expect(turn5Screenshot).not.toBeNull();
    expect(turn7).not.toBeNull();
    expect(turn17End).not.toBeNull();
    expect(turn23Choice).not.toBeNull();
    if (turn1 === null || turn5Screenshot === null || turn17End === null) return;

    expect(turn1.shop.map((m) => m.cardId)).toEqual(['BG31_330', 'BG33_140', 'BG29_888']);
    expect(turn1.shopSpells.map((s) => s.cardId)).toEqual(['BG28_504']);

    expect(turn5Screenshot.board.map((m) => m.cardId)).toEqual(['BG36_200', 'BG26_805']);
    expect(turn5Screenshot.hand.map((m) => m.cardId)).toEqual(['BG32_330']);

    expect(turn17End.hand.map((m) => m.cardId)).toContain('BG26_137');
  });

  /**
   * Пункт 1 (скриншот хода 1): «рекомендовало купить дракона вместо
   * экономического мурлока, который поможет активировать способность героя».
   *
   * Сила героя — «Рыбалка»: «After you sell 5 minions, get a random Murloc».
   * Она называет и продажу, и племя, а ценность покупки читала только борд
   * и текст самой карты. River Skipper — ровно та карта, которую эта сила
   * хочет: её обещание реализуется продажей, и продажа же двигает счётчик.
   */
  it('пункт 1: сила героя поднимает экономического мурлока выше дракона', () => {
    expect(turn1).not.toBeNull();
    if (turn1 === null) return;

    const skipper = turn1.shop.find((m) => m.cardId === 'BG33_140');
    const dragon = turn1.shop.find((m) => m.cardId === 'BG29_888');
    expect(skipper).toBeDefined();
    expect(dragon).toBeDefined();
    if (skipper === undefined || dragon === undefined) return;

    const skipperValue = minionValue(skipper, turn1, { cards });
    // Племя из силы (1.0) плюс продажа, которую сила вознаграждает (2.5).
    expect(skipperValue.heroPower).toBeCloseTo(3.5, 5);
    // У дракона ни племени силы, ни продажи — слагаемое пустое.
    expect(minionValue(dragon, turn1, { cards }).heroPower).toBe(0);
    expect(skipperValue.total).toBeGreaterThan(minionValue(dragon, turn1, { cards }).total);

    const advice = adviseTavern(turn1, { cards });
    expect(advice?.recommendations[0]?.action).toBe('buy');
    expect(advice?.recommendations[0]?.minion?.cardId).toBe('BG33_140');
  });

  /**
   * Пункт 1, вторая половина: «морозить заклинание уже не нужно — купленный
   * мурлок и так даст купить два существа на 3 ходу».
   *
   * ЭТОТ ПУНКТ НЕ ЗАКРЫТ, и тест пришпиливает нынешнее поведение нарочно.
   *
   * Заморозка витрины ради заклинания, дающего миньона, — правило part17
   * (ход 1: игрок сам её сделал и совет одобрил) и part19 (ход 3: игрок
   * пожаловался, что совет ИСЧЕЗ после подъёма). Здесь тот же совет назван
   * ненужным. Довод игрока — не про заморозку вообще, а про его экономику:
   * River Skipper продаётся за золото И приносит миньона, поэтому второе
   * тело у него будет и без заклинания.
   *
   * Правило «сверять обещание с золотом следующего хода» было написано
   * и ОТКАЧЕНО: оно ломает и part17, и part19, где тот же совет игрок
   * одобрил. Два его собственных отзыва расходятся, и решать это должен
   * он, а не мы. Вопрос вынесен ему прямо.
   */
  it('пункт 1 (НЕ ЗАКРЫТ): заморозка заклинания остаётся — правило part17', () => {
    expect(turn1).not.toBeNull();
    if (turn1 === null) return;

    // В самой точке решения золота хватает на заклинание (3 против 2),
    // поэтому морозить нечего — его просто покупают. Совет появляется
    // в ПЛАНЕ, после того как три золота ушли на мурлока.
    expect(freezeRule(turn1, { cards })?.spellCardId).toBeUndefined();

    const plan = spendPlan(turn1, { cards });
    expect(plan.steps.map((s) => s.recommendation.spellCardId)).toContain('BG28_504');
  });

  /**
   * Пункт 2 (скриншот хода 5): «предлагает выставить карту, которая и так
   * выпадет из руки, но с меньшей ценностью».
   *
   * Flighty Scout: «Start of Combat: If this minion is in your hand, summon
   * a copy of it». Тел в бою поровну, а разыгранная карта занимает слот
   * навсегда. Купить её при этом по-прежнему стоит — из руки она и работает.
   */
  it('пункт 2: карта, работающая из руки, не советуется к розыгрышу', () => {
    expect(turn5Screenshot).not.toBeNull();
    if (turn5Screenshot === null) return;

    const scout = turn5Screenshot.hand[0];
    expect(scout?.cardId).toBe('BG32_330');
    if (scout === undefined) return;
    expect(isHandWorker(scout, cards)).toBe(true);

    const plays = playRules(turn5Screenshot, { cards });
    expect(plays.some((r) => r.minion?.cardId === 'BG32_330')).toBe(false);

    const plan = spendPlan(turn5Screenshot, { cards });
    expect(
      plan.steps.some(
        (s) => s.recommendation.action === 'play' && s.recommendation.minion?.cardId === 'BG32_330',
      ),
    ).toBe(false);
  });

  /**
   * Пункт 2, вторая половина: «рекомендует почему-то заморозить жука
   * из 1 таверны».
   *
   * Buzzing Vermin 1/1 первого тира при таверне 2 держался как «свой
   * по племени» — на борде два зверя. Тот же довод, что у пары в part15:
   * витрина второго тира предложит зверя не хуже, и отдавать за карту
   * НИЖЕ тира бесплатное обновление незачем.
   */
  it('пункт 2: витрина не морозится ради соплеменника ниже тира таверны', () => {
    expect(turn5Screenshot).not.toBeNull();
    if (turn5Screenshot === null) return;

    // Условия жалобы: таверна 2, в витрине зверь первого тира, на борде
    // два своих зверя — прежде этого хватало на заморозку.
    expect(turn5Screenshot.techLevel).toBe(2);
    const vermin = turn5Screenshot.shop.find((m) => m.cardId === 'BG31_803');
    expect(vermin).toBeDefined();
    expect(cards.info('BG31_803')?.techLevel).toBe(1);

    expect(freezeRule(turn5Screenshot, { cards })?.minion?.cardId).not.toBe('BG31_803');
  });

  it('пункт 2: но купить такую карту советуется по-прежнему', () => {
    expect(turn5Decision).not.toBeNull();
    if (turn5Decision === null) return;

    // В точке решения того же хода разведчик ещё лежит в витрине — и он
    // верхняя покупка. Запрет живёт только в правиле розыгрыша.
    expect(turn5Decision.shop.map((m) => m.cardId)).toContain('BG32_330');
    const advice = adviseTavern(turn5Decision, { cards });
    expect(advice?.recommendations[0]?.action).toBe('buy');
    expect(advice?.recommendations[0]?.minion?.cardId).toBe('BG32_330');
  });

  /**
   * Пункт 3 (ходы 7 и дальше): «почему-то советует морозить Лассо,
   * практического эффекта от карты не вижу».
   *
   * ЗАКРЫТ ЧАСТИЧНО — исправлена ОЦЕНКА, но не сам совет.
   *
   * Enchanted Lasso крадёт ИЗ ТАВЕРНЫ, то есть из той самой витрины, которую
   * мы сейчас и оцениваем. Ожидание считалось средним по ВСЕЙ витрине, а к
   * моменту применения лучших карт в ней не будет — мы их купим сами. Лучшая
   * карта считалась дважды: и «мы её купим», и «лассо может её дать».
   * Теперь ожидание берётся по тому, что ОСТАНЕТСЯ после покупок того хода.
   *
   * Сам совет заморозки остаётся: он из part19, где игрок пожаловался
   * на его ИСЧЕЗНОВЕНИЕ. Тест пришпиливает и это — чтобы будущая правка
   * была осознанной, а не случайной.
   */
  it('пункт 3: «крадёт из витрины» — читаемый признак, отличный от «даёт миньона»', () => {
    const lasso = cards.info('BG28_512')?.text ?? '';
    const trainee = cards.info('BG28_504')?.text ?? '';
    const fromShop = (text: string): boolean =>
      DEFAULT_TAVERN_RULES.givesMinionFromShopWords.some((w) => new RegExp(w, 'i').test(text));

    // «Steal a random minion from the Tavern» — из витрины.
    expect(fromShop(lasso)).toBe(true);
    // «Get a random Tier 1 minion» — из пула, витрина ни при чём.
    expect(fromShop(trainee)).toBe(false);
  });

  /**
   * ЗАКРЫТ 17.08 — слово игрока пришло в part23: «это работает для ранней
   * игры; дальше получать за 2 золота существо из 1 таверны не настолько
   * хорошая идея».
   *
   * Ответ оказался не про заморозку, а про ЦЕНУ: заклинание тратит золото
   * того же хода, что и покупка, и обязано перебить покупку — «свежую карту
   * своего тира». Планка растёт с тиром сама, и на втором тире лассо её уже
   * не берёт (8.4 у свежей карты против ~5.5 у средней доживающей). Правило
   * part19, внесённое по обратной стороне того же спора, отменено вместе
   * с этим — там тест переписан и хранит историю.
   */
  it('пункт 3 (ЗАКРЫТ part23): лассо не держит витрину на втором тире', () => {
    expect(turn7).not.toBeNull();
    if (turn7 === null) return;

    expect(turn7.techLevel).toBe(2);
    const plan = spendPlan(turn7, { cards });
    expect(plan.steps.some((s) => s.recommendation.spellCardId === 'BG28_512')).toBe(false);
    // 27.08 (part29): витрину план не держит здесь ВООБЩЕ — ни ради
    // заклинания, ни ради продажного генератора (River Skipper, `BG33_140`,
    // держал её с part25). Ход 7 — четвёртый ход таверны, на следующем
    // будет семь золота: две покупки и без предложения, и с ним, — лишнего
    // тела нет, и «два тела вместо одного» тут неправда. Это ровно тот
    // совет, про который игрок в этой же партии сказал «не вижу
    // практического эффекта», и снят он счётом, а не порогом.
    expect(plan.steps.some((s) => s.recommendation.action === 'freeze')).toBe(false);
  });

  /**
   * Пункт 4 (скриншот конца хода 17): «снова предлагает выставить карту,
   * которая улучшается именно от того, что она в руке».
   *
   * Bream Counter: «While this is in your hand, after you play a Murloc,
   * gain +{0}/+{1}». Розыгрыш останавливает рост; игрок держал счетовода
   * в руке, и тот дорос с 208/206 до 670/668.
   */
  it('пункт 4: растущая в руке карта не советуется к розыгрышу через продажу', () => {
    expect(turn17End).not.toBeNull();
    if (turn17End === null) return;

    const counter = turn17End.hand.find((m) => m.cardId === 'BG26_137');
    expect(counter).toBeDefined();
    if (counter === undefined) return;
    expect(counter.attack).toBe(208);
    expect(isHandWorker(counter, cards)).toBe(true);

    const plays = playRules(turn17End, { cards });
    expect(plays.some((r) => r.minion?.cardId === 'BG26_137')).toBe(false);
    // И жертву ради него никто не назначает.
    expect(
      plays.some((r) => r.sellFirst !== null && r.minion?.cardId === 'BG26_137'),
    ).toBe(false);
  });

  /**
   * Пункт 5 (скриншот хода 23): «на столе Бранн и есть золото — выгоднее
   * брать карты, которые позволяют прокрутить статы, а не карту, которая
   * даёт эффект лишь в конце хода».
   *
   * Бранн удваивает кличи, и «Battlecry and Deathrattle: Get a Deepwater
   * Clan» приносит при нём две карты. `perTextMechMate` считал Бранна
   * рядовой связью в полторы очка, и кличевой мурлок стоял вторым.
   */
  it('пункт 5: при Бранне кличевой вариант обходит эффект конца хода', () => {
    expect(turn23Choice).not.toBeNull();
    if (turn23Choice === null) return;

    expect(turn23Choice.board.some((m) => m.cardId === 'BG_LOE_077')).toBe(true);
    const options = (turn23Choice.openChoice?.options ?? []).map((o) => o.cardId).sort();
    expect(options).toEqual(['BG35_142', 'BG35_143', 'BG36_507']);

    const ranked = choiceAdvice(turn23Choice, { cards });
    expect(ranked[0]?.option.cardId).toBe('BG35_143');
    // Лишняя принесённая карта считается тем же курсом, что прокрутка
    // генератора и заклинание от силы героя.
    expect(ranked[0]?.value?.doubler).toBe(DEFAULT_TAVERN_RULES.heroPowerSpellValue);
    // У варианта с эффектом конца хода удваивать некому: Drakkari на борде нет.
    expect(ranked.find((r) => r.option.cardId === 'BG35_142')?.value?.doubler).toBe(0);
  });
});
