import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, minionValue } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';
import { createBreather } from '../breather.js';
import { part65Game } from '../fixtures.js';

/**
 * part65 — 22.09.2026, 3-е место. Фактура партии — в `test/fixtures.ts`.
 *
 * Жалоба игрока по кадру 15:31:55 дословно: «предлагает выбрать целью карту,
 * которая не может быть целью». На кадре советник говорил
 * `АКТИВИРОВАТЬ Brain Rotter 3/8 → на Wrath Weaver 6/8` и оценивал нажатие
 * в «+4 статов», то есть считал прибавку статами НАШЕГО борда.
 *
 * И цель, и число — про получателя, которого на столе нет: Brain Rotter
 * `BG36_099` — «Activate ({2}): Discard a card to give your **Deity**
 * +{0}/+{1}». Божество живёт скрытой сущностью в зоне SECRET и выходит
 * на стол только в бою, пробудившись (D276).
 */
describe('part65: Божество — получатель, которого нет на столе', () => {
  let cards: CardIndex;
  let state: GameState;
  let brainRotter: Minion;

  beforeAll(() => {
    cards = loadCardIndex();
    const clock = parseClock('15:31:55');
    expect(clock).not.toBeNull();
    const slice = sliceLogByClock(part65Game(), clock!);
    expect(slice?.inGame).toBe(true);
    state = frameAt(slice!).state;
    const found = state.board.find((m) => m.cardId === 'BG36_099');
    expect(found).toBeDefined();
    brainRotter = found!;
  }, 600_000);

  it('кадр воспроизводится: Brain Rotter на борде, активация бесплатна', () => {
    // Кадр из жалобы: золото потрачено до нуля, таверна поднята до 3.
    expect(state.gold).toBe(0);
    expect(state.techLevel).toBe(3);
    // Нажатие доступно и стоит ноль — то есть молчание совета не объясняется
    // ни ценой, ни исчерпанностью: правило доходит до разбора текста.
    expect(brainRotter.tags['HAS_ACTIVATE_POWER']).toBeGreaterThan(0);
    expect(brainRotter.tags['INTERACTABLE_OBJECT_COST'] ?? 0).toBe(0);
    // Цель, которую советник называл в жалобе, на борде есть — и именно
    // она крупнейшая, то есть общее правило «крупнейший свой» указало бы
    // на неё снова.
    const weaver = state.board.find((m) => m.cardId === 'BGS_004' && (m.attack ?? 0) === 6);
    expect(weaver).toBeDefined();
  });

  it('активация, кормящая Божество, не целит в миньона стола и не советуется', () => {
    const advice = adviseTavern(state, { cards });
    const activations = (advice?.recommendations ?? []).filter((r) => r.action === 'activate');
    // Ни одной активации: весь эффект нажатия уходит Божеству, а статами
    // борда он не становится. Прежде здесь стоял совет 2.0 очка с целью.
    expect(activations).toEqual([]);
    // И в план он тоже не попадает — на кадре игрок видел его вторым шагом.
    const plan = spendPlan(state, { cards });
    expect(plan.steps.map((s) => s.recommendation.action)).not.toContain('activate');
  });

  it('прибавка Божеству не входит в ценность тела статами борда', () => {
    // `activation` — слагаемое ценности миньона на нашей шкале статов.
    // У Brain Rotter оно обязано быть нулём: «+2/+2» уходит не на стол.
    expect(minionValue(brainRotter, state, { cards }).activation).toBe(0);
  });
});

/**
 * Поглощение витрины заклинанием ИЗ РУКИ (D277).
 *
 * D271 завёл это правило по фикстуре part63 — но только для ПОКУПКИ
 * заклинания из витрины. В part65 те же карты приходили в руку по нулевой
 * цене (их давал Eredar Escapist `BG36_733` за урон герою), и там правила
 * не было: за партию игрок разыграл 7 × Methodical Madness `BG36_880`
 * и 5 × Corrupted Cupcakes `BG28_607`, а советник не назвал ни одной.
 *
 * Кадр 15:48:05 — предел этой слепоты: в руке ШЕСТЬ таких заклинаний
 * по нулю, в витрине три тела, и вся речь советника про магниты.
 */
describe('part65: пожиратели витрины из руки', () => {
  let cards: CardIndex;
  let state: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    const clock = parseClock('15:48:05');
    const slice = sliceLogByClock(part65Game(), clock!);
    expect(slice?.inGame).toBe(true);
    state = frameAt(slice!).state;
  }, 600_000);

  it('кадр воспроизводится: шесть бесплатных пожирателей в руке', () => {
    const free = state.handSpells.filter(
      (s) => s.cardId === 'BG36_880' || s.cardId === 'BG28_607',
    );
    expect(free.length).toBe(6);
    expect(free.every((s) => s.cost === 0)).toBe(true);
    // Есть кого съесть и кому скормить: без витрины правило молчит по D034.
    expect(state.shop.length).toBe(3);
  });

  it('советует разыграть пожирателя из руки и называет получателя', () => {
    const advice = adviseTavern(state, { cards });
    const eaters = (advice?.recommendations ?? []).filter(
      (r) => r.action === 'play' && (r.spellCardId === 'BG28_607' || r.spellCardId === 'BG36_880'),
    );
    expect(eaters.length).toBeGreaterThan(0);

    // Цель — КРУПНЕЙШИЙ свой демон, как и у покупки такого же заклинания
    // из витрины: съеденное остаётся на нём навсегда (D142).
    const top = eaters[0]!;
    expect(cards.info(top.targetMinion?.cardId ?? '')?.name).toBe("Insatiable Ur'zul");

    // Съедаются три тела витрины из трёх — Cupcakes сильнее Madness, потому
    // что та ест два. Обе на нашей шкале статов, цена нулевая.
    const cupcakes = eaters.find((r) => r.spellCardId === 'BG28_607');
    const madness = eaters.find((r) => r.spellCardId === 'BG36_880');
    expect(cupcakes).toBeDefined();
    expect(madness).toBeDefined();
    expect(cupcakes!.score).toBeGreaterThan(madness!.score);
    expect(cupcakes!.cost).toBe(0);
  });
});

/**
 * ТРЕТЬЯ поверхность того же текста (D278) — КЛИЧ миньона.
 *
 * D271 завёл поглощение витрины триггером, D277 — заклинанием из руки,
 * а Mind Muck `BG23_357` («Battlecry: Choose a friendly Demon. It consumes
 * a minion in the Tavern to gain its stats», тир 2) до сих пор считался
 * голым телом 6/5. В этой партии он лежал в витрине на ходах 21 и 23 —
 * при шести и семи своих демонах, — и ровно те же статы, что советник
 * считает у заклинания, у миньона стоили ноль.
 *
 * Отличие от триггера — ЧАСТОТА: клич отыгрывает однажды, при розыгрыше,
 * поэтому множителя за ход таверны нет. Отрицательная сторона правила
 * (кормить некого) закреплена на part62.
 */
describe('part65: клич, кормящий витриной своего демона (D278)', () => {
  let cards: CardIndex;
  let turns: TavernTurn[];

  beforeAll(async () => {
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(part65Game(), createBreather());
  }, 600_000);

  it('ход 21: Mind Muck в витрине получает очки за поглощение, и они не от триггера', () => {
    const state = turns.find((t) => t.turn === 21)?.state;
    expect(state).toBeDefined();
    const muck = state!.shop.find((m) => m.cardId === 'BG23_357');
    expect(muck).toBeDefined();

    const value = minionValue(muck!, state!, { cards });
    expect(value.battlecryEater).toBeGreaterThan(0);
    // Слагаемое ТРИГГЕРА молчит: голова у этого текста другая, и дважды
    // одно и то же в ценность не попадает.
    expect(value.tavernEater).toBe(0);
    // Тело 6/5 на нашей шкале статов стоит 5.5 — прибавка клича с ним
    // сравнима, то есть правило двигает выбор, а не округление.
    expect(value.battlecryEater).toBeGreaterThan(5);
  });

  it('свой на борде очков за клич не приносит: он уже отыгран', () => {
    const state = turns.find((t) => t.turn === 21)?.state;
    const muck = state!.shop.find((m) => m.cardId === 'BG23_357');
    // Тот же миньон, но числящийся на борде, — клич позади (граница взята
    // у `tavernEaterValue`, где она стоит с D271).
    const asOwn = { ...muck!, entityId: state!.board[0]!.entityId };
    expect(minionValue(asOwn, state!, { cards }).battlecryEater).toBe(0);
  });
});
