import { beforeAll, describe, expect, it } from 'vitest';

import {
  activationRules,
  adviseTavern,
  buffTarget,
  heroPowerBuyDiscount,
  heroPowerRule,
  setStatsOf,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part40Game } from '../fixtures.js';

/**
 * part40 — тридцать вторая партия с оверлеем (04.09.2026, Пират Глазастик
 * `TB_BaconShop_HERO_18`, пираты, 5-е место), четырнадцатая на билде 250339.
 *
 * Четыре пункта игрока, и все четыре — настоящие. Три закрыты правками,
 * четвёртый (цель усиления) заведён под флаг и ждёт своего замера; тест
 * держит и правки, и границы, за которые они НЕ переходят.
 *
 * Скриншоты сняты В СЕРЕДИНЕ хода, а не в точке решения, поэтому три
 * из четырёх состояний восстанавливаются срезом лога по времени.
 */
describe('part40: пираты Патчеса — активации, продажа под силу и скидка от пиратов', () => {
  let text: string;
  let cards: CardIndex;
  let turns: TavernTurn[];

  /**
   * Состояние на КОНЕЦ указанной секунды лога.
   *
   * Срез по времени, а не по точной подстроке: скриншоты сняты в середине
   * хода, и в нужную секунду лог может не писать ни строки (у 20:02:18
   * и 20:04:05 их нет вовсе). Точка решения тут не годится в принципе —
   * она снята до первой траты золота, а спорные состояния наступили после.
   */
  const reduceTo = (second: string): GameState => {
    const lines = text.split(/\r?\n/);
    let cut = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(lines[i] ?? '');
      if (m !== null && (m[1] as string) > second) {
        cut = i;
        break;
      }
    }
    expect(cut, `в логе должны быть строки после ${second}`).toBeLessThan(lines.length);
    const slice = lines.slice(0, cut).join('\n');
    const reducer = createReducer(readPlayers(slice));
    for (const event of readPowerEvents(slice)) reducer.step(event);
    return reducer.snapshot();
  };

  const name = (cardId: string): string => cards.info(cardId)?.name ?? cardId;

  beforeAll(() => {
    text = part40Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  it('Пират Глазастик, 5-е место, 24 хода', () => {
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    const state = reducer.snapshot();
    expect(state.hero?.cardId).toBe('TB_BaconShop_HERO_18');
    expect(state.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_072');
    expect(state.finalPlace).toBe(5);
    expect(state.buildNumber).toBe(250339);
  });

  // ── Пункт 1: КОМУ достаётся усиление ───────────────────────────────────
  //
  // Правило заведено под флагом и по умолчанию НЕ включено: одна точка
  // правилом не становится. Тест держит обе ветви, чтобы вердикт замера
  // сводился к одной строке в rules.ts, а не к правке кода.

  it('ход 11: усиление целится в крупнейшее тело, а под флагом — в носителя вихря (пункт 1)', () => {
    const state = reduceTo('20:02:18');
    expect(state.turn).toBe(11);
    expect(state.gold).toBe(0);
    // Repair Job BG36_624 в руке, плейсхолдеры +4/+9 — теги сущности.
    const repairJob = state.handSpells.find((s) => s.cardId === 'BG36_624');
    expect(repairJob?.scriptData.slice(0, 2)).toEqual([4, 9]);

    const byStats = buffTarget(state, { cards }, DEFAULT_TAVERN_RULES);
    expect(name(byStats?.cardId ?? '')).toBe('Locked-up Mutineer');

    const byWindfury = buffTarget(
      state,
      { cards },
      { ...DEFAULT_TAVERN_RULES, buffTargetPreference: 'windfury' },
    );
    expect(name(byWindfury?.cardId ?? '')).toBe('Crackling Cyclone');
    expect(byWindfury?.windfury).toBe(true);

    // Умолчание остаётся прежним, пока `spike:bufftarget` не возьмёт порог.
    expect(DEFAULT_TAVERN_RULES.buffTargetPreference).toBe('stats');
  });

  // ── Пункт 2: продажа оплачивает силу героя ─────────────────────────────

  it('ход 13: на полном борде продажа оплачивает силу героя (пункт 2)', () => {
    const state = reduceTo('20:04:05');
    expect(state.turn).toBe(13);
    expect(state.gold).toBe(1);
    expect(state.board).toHaveLength(7);
    expect(state.hero?.heroPowerCost).toBe(2);
    expect(state.hero?.heroPowerUsedThisTurn).toBe(false);

    // Прежде правило гасло привратником `cost > state.gold`, и оверлей
    // печатал одно «НИЧЕГО»; игрок в этот момент продал миньона и нажал.
    const rec = heroPowerRule(state, { cards });
    expect(rec).not.toBeNull();
    expect(rec?.cost).toBe(2);
    expect(rec?.sellFirst).not.toBeNull();

    // Совет доходит до экрана, а не тонет ниже «ничего не делать».
    const advice = adviseTavern(state, { cards });
    expect(advice?.recommendations[0]?.action).toBe('heroPower');

    // План применяет шаг по-настоящему: жертва уходит с борда, а её золото
    // доезжает до остатка — иначе шаг стоил бы золота, которого нет.
    const plan = spendPlan(state, { cards });
    const step = plan.steps[0];
    expect(step?.recommendation.action).toBe('heroPower');
    expect(step?.goldAfter).toBe(0);
    expect(step?.stateAfter.board).toHaveLength(6);
  });

  it('без полного борда продажа силу не оплачивает — граница правки (пункт 2)', () => {
    // Прибавка идёт только туда, где продажа и так подразумевается.
    // На ходу 9 борд неполон (5 из 7), и правило обязано остаться прежним:
    // «продать ради монеты» оно не советует.
    const turn9 = turns.find((t) => t.state.turn === 9);
    expect(turn9).toBeDefined();
    const state = turn9?.state as GameState;
    expect(state.board.length).toBeLessThan(DEFAULT_TAVERN_RULES.boardSize);
    expect(heroPowerRule(state, { cards })?.sellFirst ?? null).toBeNull();
  });

  // ── Пункт 3: активация Тираэля ────────────────────────────────────────

  it('ход 17: «задать статы» читается и советуется (пункт 3)', () => {
    const state = reduceTo('20:08:53');
    expect(state.turn).toBe(17);
    expect(state.gold).toBe(2);

    const tyrael = state.board.find((m) => m.cardId === 'BG36_356');
    expect(tyrael).toBeDefined();
    expect(tyrael?.scriptData.slice(0, 3)).toEqual([1, 50, 50]);

    // Числа абсолютные: цена 1 из {0}, статы 50/50 из {1}/{2}.
    const set = setStatsOf(
      tyrael as NonNullable<typeof tyrael>,
      "Set another minion's stats to {1}/{2}.",
    );
    expect(set).toEqual({ attack: 50, health: 50, total: 100 });

    const rec = activationRules(state, { cards }).find((r) => r.minion?.cardId === 'BG36_356');
    expect(rec).toBeDefined();
    expect(rec?.cost).toBe(1);
    // Цель ОБРАТНАЯ правилу «крупнейший»: прибавку получает тот, кому
    // задать статы выгоднее всего, — Кривоклык 5/4, ровно как у игрока
    // (20:08:59, блок с `Target=`).
    expect(name(rec?.targetMinion?.cardId ?? '')).toBe('Hooktusk, Master Marauder');
    expect(rec?.reason).toContain('50/50');

    // И это верхний совет, а не строка ниже «ОБНОВИТЬ за 1».
    const advice = adviseTavern(state, { cards });
    expect(advice?.recommendations[0]?.action).toBe('activate');
  });

  it('ход 17: разыгранный в этом ходу миньон не числится активированным (пункт 3, редьюсер)', () => {
    const state = reduceTo('20:08:53');
    const byName = (n: string): number =>
      state.board.find((m) => name(m.cardId) === n)?.entityId ?? -1;

    // Выставлены в этом ходу — нажатыми не числятся.
    for (const n of ['Tyrael', 'Blade Collector', 'Hooktusk, Master Marauder']) {
      expect(state.activatedEntityIds, n).not.toContain(byName(n));
    }
    // А вот Clever Castaway игрок в этом ходу правда нажал (20:08:20,
    // блок PLAY с `zone=PLAY`) — и он помечен верно.
    expect(state.activatedEntityIds).toContain(byName('Clever Castaway'));
  });

  // ── Пункт 4: скидка силы от покупки пирата ────────────────────────────

  it('скидка силы от покупки пирата читается из текста (пункт 4)', () => {
    const state = reduceTo('20:04:05');
    expect(heroPowerBuyDiscount(state, cards)).toEqual({ race: 'PIRATE', amount: 1 });
  });

  it('ход 13: план считает силу уже со скидкой от своей же покупки (пункт 4)', () => {
    const turn13 = turns.find((t) => t.state.turn === 13);
    expect(turn13).toBeDefined();
    const state = turn13?.state as GameState;
    expect(state.hero?.heroPowerCost).toBe(2);

    const plan = spendPlan(state, { cards });
    const kinds = plan.steps.map((s) => s.recommendation.action);
    expect(kinds).toContain('buy');
    expect(kinds).toContain('heroPower');

    // Покупка пирата стоит в плане ПЕРЕД нажатием, и нажатие стоит уже 1,
    // а не 2: скидку приносит собственный шаг плана.
    const buyAt = kinds.indexOf('buy');
    const powerAt = kinds.indexOf('heroPower');
    expect(buyAt).toBeLessThan(powerAt);
    expect(plan.steps[powerAt]?.recommendation.cost).toBe(1);
    // Весь ход укладывается в девять золотых до нуля.
    expect(plan.steps[plan.steps.length - 1]?.goldAfter).toBe(0);
  });

  it('ход 21: без пиратов в витрине скидка инертна — план не двигается (пункт 4)', () => {
    const turn21 = turns.find((t) => t.state.turn === 21);
    expect(turn21).toBeDefined();
    const state = turn21?.state as GameState;
    expect(state.gold).toBe(10);
    expect(state.shop.every((m) => !(cards.info(m.cardId)?.races ?? []).includes('PIRATE'))).toBe(
      true,
    );

    const plan = spendPlan(state, { cards });
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual([
      'heroPower',
      'play',
      'levelUp',
    ]);
    expect(plan.steps[0]?.recommendation.cost).toBe(3);
  });
});
