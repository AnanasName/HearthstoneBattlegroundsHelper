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
