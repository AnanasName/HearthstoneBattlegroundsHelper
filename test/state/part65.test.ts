import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, minionValue } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { frameAt, parseClock, sliceLogByClock } from '../../src/ui/logSlice.js';
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
