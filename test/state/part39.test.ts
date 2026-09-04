import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  freeHeroPowerRule,
  heroPowerGoldRule,
  heroPowerKeywordRule,
  heroPowerRule,
  heroPowerShotRule,
  heroPowerSpellRule,
  levelUpRule,
  spinRule,
  type Recommendation,
} from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { part39Game } from '../fixtures.js';

/**
 * part39 — тридцать первая партия с оверлеем (04.09.2026, Змеиный Глаз
 * `BG28_HERO_400`, мехи, 5-е место), тринадцатая на билде 250339.
 *
 * Четыре пункта игрока, и разбор развёл их на ДВЕ правки и ДВА «дефекта
 * нет». Тест держит обе половины: правки — чтобы не откатились молча,
 * «дефекта нет» — чтобы не переоткрывались как новые жалобы.
 *
 *  1. **Ход 1, ПРАВКА.** «Посоветовало ход со сгорающим золотом, хотя был
 *     лучший ход, который я и сделал». Дефект арифметический и лежит
 *     не в самом правиле прокрутки, а в том, КАКОЕ ЕЁ ЧИСЛО уходит в план:
 *     очки прокрутки в списке — это бамп порядка `max(base, лучшая
 *     покупка + 0.5)`, то есть ЧУЖАЯ ценность внутри собственных очков,
 *     и `chainValue` складывал Cord Puller дважды. Развилка сгорающего
 *     золота (part23) отработала честно — запустилась и взяла линию игрока
 *     в альтернативы, — но проиграла ей же 12.00 против 12.50, ровно
 *     на величину бампа. Лечится тем же полем `standaloneScore`, которым
 *     в part25 лечили подъём.
 *
 *  2. **Ход 5, ДЕФЕКТА НЕТ (правка инертна).** «Я сделал лучший ход
 *     с продажей и улучшением таверны». Лог подтверждает посекундно:
 *     16:43:50 продажа свинобраза (+1 временным золотом), 16:43:51 подъём
 *     за 6. Привратник подъёма `cost > state.gold` золота от продажи
 *     не видит — это правда, — но подъём на этом ходу стоит НОЛЬ очков
 *     (таверна идёт по графику), то есть починка привратника не двигает
 *     ни строки на экране. Настоящая причина — кривая подъёма, и это
 *     открытое решение владельца данных (замер 03.09: «только игрок»
 *     62 против «только план» 24), а не дефект.
 *
 *  3. **Ход 13, ПРАВКА.** «Не советует нажать силу героя». «Удачный
 *     бросок» `BG28_HERO_400p` («Roll a 6-sided die. Gain that much
 *     Gold», COST=1) не читался НИ ОДНИМ из пяти правил силы. Дыра чисто
 *     текстовая: разбор золота требовал ЦИФРУ и «that much» не видел —
 *     тот же класс, что счёт словом против цифры в part38. Кулдаун при
 *     этом читался верно и ДО правки, и это половина, которую легко
 *     принять за дефект: сила по-настоящему открыта ровно в одной точке
 *     решения из десяти — на ходу 13, том самом скриншоте.
 *
 *  4. **Расстановка, ДЕФЕКТА НЕТ по мерке, но есть по подаче.**
 *     «Предложило поставить на первое место существо с предсмертным
 *     хрипом, которое позже было усилено из-за trinket». Тринкет —
 *     Emergency Gearblade `BG36_MagicItem_812` («At the end of your turn,
 *     cast Repair Job on your left-most Mech»): он делает ЛЕВЫЙ СЛОТ
 *     платным, и советник этого не читает вовсе. Но слепота ИНЕРТНА —
 *     ближайший бой предпочитает того же миньона первым и с учётом
 *     тринкета, — а цена, которую чувствует игрок, лежит за горизонтом
 *     ближайшего боя, где у проекта мерки нет (`spike:hand` объявлен
 *     негодным по построению, docs/deferred.md).
 */
describe('part39: своя ценность прокрутки и сила героя, дающая золото', () => {
  const SNAKE_EYES = 'BG28_HERO_400';
  /** Нажимаемая версия силы: COST=1, HAS_ACTIVATE_POWER=1. */
  const LUCKY_ROLL = 'BG28_HERO_400p';
  /** Та же сила на перезарядке: LOCK_VISUAL=1, без цены и без активности. */
  const LUCKY_ROLL_CD = 'BG28_HERO_400p2';
  const RAZORFEN = 'BG20_100';
  const METALLIC_HUNTER = 'BG32_170';
  const GEARBLADE_DBF = 133695;

  let cards: CardIndex;
  let points: { readonly state: GameState }[];
  let end: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    const text = part39Game();
    points = readTavernTurns(text).map((p) => ({ state: p.state }));
    const last = points.at(-1);
    if (last === undefined) throw new Error('точек решения нет');
    end = last.state;
  }, 900_000);

  const deps = (): { cards: CardIndex } => ({ cards });
  const at = (turn: number): GameState => {
    const p = points.find((x) => x.state.turn === turn);
    if (p === undefined) throw new Error(`нет точки решения на ходу ${String(turn)}`);
    return p.state;
  };
  const topAdvice = (s: GameState): Recommendation => {
    const top = adviseTavern(s, deps())?.recommendations[0];
    if (top === undefined) throw new Error('советов нет');
    return top;
  };

  it('партия читается целиком: Змеиный Глаз, билд 250339, десять точек решения', () => {
    expect(end.hero?.cardId).toBe(SNAKE_EYES);
    expect(end.buildNumber).toBe(250339);
    // Партия доиграна до FINAL_GAMEOVER: без него `finalPlace` читался бы
    // как ТЕКУЩЕЕ место и дал бы другое число, выглядящее как правда
    // (урок обрезанного лога part38).
    expect(end.finalPlace).toBe(5);
    expect(points.map((p) => p.state.turn)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19]);
  });

  // ── Пункт 1: своя ценность прокрутки ──────────────────────────────────

  /**
   * Фактура жалобы: клич платит за РОЗЫГРЫШ, а не за продажу, поэтому
   * два самоцвета игрок получил и оставив тело. Прокрутка отдаёт тело
   * за монету — и осмысленна ровно тогда, когда монета что-то покупает.
   */
  it('ход 1: клич свинобраза срабатывает при розыгрыше — тело можно оставить', () => {
    expect(cards.info(RAZORFEN)?.text ?? '').toMatch(/Battlecry/i);
    const s = at(1);
    expect(s.gold).toBe(7);
    // Семь золотых раскладываются в 3 + 3 + 1 БЕЗ остатка — то есть монета,
    // которую освобождает продажа, покупать ей нечего.
    expect(s.shop.every((m) => (m.buyCost ?? 3) === 3)).toBe(true);
  });

  it('ход 1: у прокрутки своя ценность НИЖЕ очков списка — бамп порядка внутрь плана не идёт', () => {
    // Очки СПИСКА берутся из полного прохода правил: бамп считается против
    // лучшей покупки, и без неё (пустой `buys`) его просто нет.
    const listed = topAdvice(at(1));
    expect(listed.action).toBe('spin');
    expect(listed.score).toBe(7);
    // Своя ценность — без бампа. Именно эта разница и складывалась дважды.
    expect(listed.standaloneScore).toBe(6);
    expect(listed.standaloneScore).toBeLessThan(listed.score);
    // Без соперника бамп не начисляется вовсе, и оба числа совпадают —
    // это и показывает, что 7.0 приходит СНАРУЖИ правила.
    const bare = spinRule(at(1), deps(), DEFAULT_TAVERN_RULES, []);
    expect(bare?.score).toBe(6);
    expect(bare?.standaloneScore).toBe(6);
  });

  it('ход 1: план тратит всё золото — сгорающей монеты больше нет', () => {
    const plan = spendPlan(at(1), deps());
    expect(plan.goldLeft).toBe(0);
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['buy', 'buy', 'buy']);
  });

  /**
   * Ход 7 — КОНТРОЛЬ, и он в той же партии: там игрок прокрутил свинобраза
   * сам (`buy → play → sell → buy Ancestral Automaton → buy Careful
   * Investment`), и монета купила третье действие. Правило обязано остаться
   * на месте: жалоба была не на прокрутку, а на прокрутку ВПУСТУЮ.
   */
  it('ход 7: прокрутка остаётся первым шагом плана — там монета покупает третье действие', () => {
    const plan = spendPlan(at(7), deps());
    expect(plan.steps[0]?.recommendation.action).toBe('spin');
    expect(plan.goldLeft).toBe(0);
    expect(plan.steps).toHaveLength(3);
  });

  // ── Пункт 3: сила героя, дающая золото ────────────────────────────────

  it('кулдаун силы читался ВЕРНО и до правки: открыта ровно одна точка решения из десяти', () => {
    const ready = points.filter((p) => {
      const h = p.state.hero;
      return h !== null && h.heroPowerHasActivate && !h.heroPowerLocked && !h.heroPowerUsedThisTurn;
    });
    expect(ready.map((p) => p.state.turn)).toEqual([13]);
    // На перезарядке игра подменяет сущность силы: другая карта, без цены
    // и без активности, с замком `LOCK_VISUAL` (part37) и живым остатком
    // ходов в `TAG_SCRIPT_DATA_NUM_1`.
    expect(at(13).hero?.heroPowerCardId).toBe(LUCKY_ROLL);
    expect(at(13).hero?.heroPowerCost).toBe(1);
    expect(at(9).hero?.heroPowerCardId).toBe(LUCKY_ROLL_CD);
    expect(at(9).hero?.heroPowerLocked).toBe(true);
    expect(at(9).hero?.heroPowerScriptData[0]).toBe(1);
  });

  it('пять прежних правил силы на ходу 13 молчат — дыра была ЧИСТО текстовая', () => {
    const s = at(13);
    expect(heroPowerRule(s, deps())).toBeNull();
    expect(freeHeroPowerRule(s, deps())).toBeNull();
    expect(heroPowerKeywordRule(s, deps())).toBeNull();
    expect(heroPowerSpellRule(s, deps())).toBeNull();
    expect(heroPowerShotRule(s, deps())).toBeNull();
  });

  it('ход 13: сила читается кубиком из текста — ожидание (6+1)/2, в план идёт ХУДШИЙ бросок', () => {
    const rec = heroPowerGoldRule(at(13), deps());
    if (rec === null) throw new Error('сила героя не предложена');
    // (3.5 − 1) × goldPointValue(3) = 7.5. Число граней взято из текста
    // группой шаблона, а не подставлено константой.
    expect(rec.score).toBeCloseTo(7.5, 5);
    expect(rec.cost).toBe(1);
    // В ПЛАН идёт нижняя грань: цепочку нельзя строить на 3.5 золота —
    // сумме, которой у игрока не бывает никогда (иначе вернётся симптом
    // part24 «откроется покупка X», а покупка не открывается).
    expect(rec.grantsGold).toBe(1);
    expect(rec.reason).toMatch(/кубик 1–6/);
    expect(rec.reason).toMatch(/в среднем 3\.5/);
  });

  it('ход 13: сила героя доходит до плана хода', () => {
    const actions = spendPlan(at(13), deps()).steps.map((s) => s.recommendation.action);
    expect(actions).toContain('heroPower');
  });

  it('на перезарядке сила не советуется — гарды part13 и part37 работают без нового канала', () => {
    for (const turn of [1, 3, 5, 7, 9, 11, 15, 17, 19]) {
      expect(heroPowerGoldRule(at(turn), deps())).toBeNull();
    }
  });

  // ── Пункт 2: продажа ради подъёма — слепота есть, правка инертна ───────

  /**
   * Жалоба верна как наблюдение, но правка привратника не двигает НИ ОДНОЙ
   * строки на экране, и тест держит именно это — чтобы вывод не пришлось
   * выводить заново, когда жалоба придёт второй раз.
   */
  it('ход 5: подъём стоит НОЛЬ очков — привратник по золоту тут ни при чём', () => {
    const s = at(5);
    // Точка решения стоит уже ПОСЛЕ продажи (продажа золота не тратит),
    // и подъём на ней по карману: 6 золотых при цене 6.
    expect(s.gold).toBe(6);
    expect(s.tavernUpgradeCost).toBe(6);
    const lvl = levelUpRule(s, DEFAULT_TAVERN_RULES, [], 3);
    // Подъём ВИДЕН и оценён нулём: таверна идёт по графику. Значит дело
    // не в бюджете, а в кривой — открытый вопрос владельца данных.
    expect(lvl?.score).toBe(0);
    expect(topAdvice(s).action).toBe('buy');
  });

  // ── Пункт 4: тринкет делает левый слот платным, и это не читается ──────

  it('тринкет игрока делает ЛЕВЫЙ слот платным, но текст тринкета не читает ни одно правило', () => {
    const mine = end.playerId === null ? [] : (end.trinketsByPlayer[end.playerId] ?? []);
    expect(mine).toContain(GEARBLADE_DBF);
    const gearblade = cards.infoByDbfId(GEARBLADE_DBF);
    expect(gearblade?.text ?? '').toMatch(/left-\s*most\s+Mech/i);
    // Миньон, о котором жалоба: его ценность в ХРИПЕ, дающем заклинание,
    // а не в статах — усиливать его тринкетом игрок и не хотел.
    expect(cards.info(METALLIC_HUNTER)?.text ?? '').toMatch(/Deathrattle/i);
  });
});
