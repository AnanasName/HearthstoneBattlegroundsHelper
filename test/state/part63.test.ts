import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, choiceAdvice, minionValue } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part63Game } from '../fixtures.js';

/**
 * part63 — Заводной Механо (20.09.2026), 5-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Партия пришла с четырьмя вопросами
 * игрока по кадрам, и три из них оказались про одно и то же: текст,
 * который советник не читает.
 *
 *  * ПОГЛОЩЕНИЕ ВИТРИНЫ триггером (D271) — Insatiable Ur'zul и Flaming
 *    Enforcer. Вся партия держалась на нём, а в ценности оно стоило ноль;
 *  * КЛИЧ, требующий жертвы своего племени (D272) — Maw Caster при нуле
 *    своей нежити брал полную надбавку за тир;
 *  * УСЛОВНОЕ УДВОЕНИЕ по племени цели (D273) — Shifting Tide на наге
 *    даёт вдвое, а цель выбиралась без этого.
 */
describe("part63: Заводной Механо — пожиратели витрины, жертва племени, нага", () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part63Game();
    lines = text.split(/\r?\n/);
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(text, createBreather());
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
  }, 600_000);

  /** Состояние на момент времени — срезом лога, как на кадре игрока. */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d\.\d+)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  const name = (id: string): string => cards.info(id)?.name ?? id;
  const turnAt = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`нет хода ${String(turn)}`);
    return found.state;
  };
  const shopCard = (state: GameState, cardId: string): Minion => {
    const found = state.shop.find((m) => m.cardId === cardId);
    if (found === undefined) throw new Error(`нет в витрине: ${name(cardId)}`);
    return found;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца, 5-е место, Заводной Механо', () => {
    expect(text.split('GameType=GT_BATTLEGROUNDS').length - 1).toBeGreaterThanOrEqual(1);
    expect(text).toContain('BuildNumber=251952');
    expect(text).toContain('STEP value=FINAL_GAMEOVER');
    expect(final.finalPlace).toBe(5);
    expect(final.hero?.cardId).toBe('BG24_HERO_204_SKIN_E');
    expect(final.hero?.heroPowerCardId).toBe('BG24_HERO_204p');
    // Сила пассивная: нажимать нечего, тега активности у неё нет вовсе.
    expect(final.hero?.heroPowerHasActivate).toBe(false);
  });

  it('ходов таверны 11, и на каждом есть точка решения', () => {
    expect(turns.map((t) => t.turn)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
  });

  /**
   * Жалоба №2 по кадру 12:16: награда за тройку из трёх карт тира 5 —
   * свинобраз при одном своём свинобразе стоил столько же, сколько демон
   * при трёх своих демонах (19.5 против 19.5).
   *
   * Причина оказалась не в весе племени, а в тексте: Insatiable Ur'zul
   * («After you play a Demon, consume a random minion in the Tavern to gain
   * its stats») — это ДВИЖОК, и он стоил ноль. За партию он съел витрину
   * до 69/75.
   */
  it('награда за тройку: пожиратель витрины обгоняет свинобраза без своего племени (D271)', () => {
    const state = at('12:16:45');
    const options = choiceAdvice(state, { cards });
    const names = options.map((a) => a.name);
    expect(names).toContain("Insatiable Ur'zul");
    expect(names).toContain('Sanguine Refiner');

    const urzul = options.find((a) => a.name === "Insatiable Ur'zul");
    const refiner = options.find((a) => a.name === 'Sanguine Refiner');
    expect(urzul?.value?.tavernEater).toBeGreaterThan(0);
    expect(urzul?.score ?? 0).toBeGreaterThan(refiner?.score ?? 0);
  });

  /**
   * Тот же текст с другой головой: «At the end of your turn, consume the
   * highest-Health minion in the Tavern to gain its stats» (Flaming Enforcer
   * `BG34_500`). На ходу 21 он в витрине 4/5 — и это тело, которое за один
   * ход таверны забирает статы самого здорового миньона витрины.
   */
  it('конец хода: Flaming Enforcer в витрине получает очки за поглощение (D271)', () => {
    const state = turnAt(21);
    const enforcer = shopCard(state, 'BG34_500');
    const value = minionValue(enforcer, state, { cards });
    expect(value.tavernEater).toBeGreaterThan(0);
  });

  /**
   * Та же механика ЗАКЛИНАНИЕМ: Methodical Madness `BG36_880` — «Choose
   * a friendly Demon. It consumes 2 random Tavern minions to gain their
   * stats and Bonus Keywords». Плюсов в тексте нет, и до D271 карта была
   * невидима целиком, хотя ровно ею игрок на ходу 15 (12:18:35) удвоил
   * Ур'зула: 9/11 → 19/21 и дальше.
   */
  it('заклинание-пожиратель витрины видно и названо с целью (D271)', () => {
    const state = at('12:18:34');
    expect(state.shopSpells.some((s) => s.cardId === 'BG36_880')).toBe(true);

    const buy = adviseTavern(state, { cards })?.recommendations.find(
      (r) => r.spellCardId === 'BG36_880',
    );
    expect(buy).toBeDefined();
    // Съедаемое — две карты витрины по её средним статам (5 карт, 60 статов).
    expect(buy?.score).toBeCloseTo(12, 5);
    // Получатель — крупнейший свой демон.
    expect(cards.info(buy?.targetMinion?.cardId ?? '')?.races).toContain('DEMON');
  });

  /**
   * Жалоба №3 по кадру 12:18: «предлагает нежить, которую я даже не смогу
   * нормально применить». Maw Caster `BG32_340` — «Battlecry: Destroy
   * a friendly Undead to Discover an Undead», а своей нежити на борде НОЛЬ:
   * клич не сработает вовсе, и надбавку за тир платить нечем (D272).
   */
  it('клич, требующий жертвы своего племени, без такой нежити лишается надбавки за тир (D272)', () => {
    const state = turnAt(15);
    const undead = state.board.filter((m) => (cards.info(m.cardId)?.races ?? []).includes('UNDEAD'));
    expect(undead).toHaveLength(0);

    const maw = shopCard(state, 'BG32_340');
    const value = minionValue(maw, state, { cards });
    expect(value.techLevel).toBe(0);
    // Осталось ровно тело: 4/5 и провокация от силы героя.
    expect(value.total).toBeLessThan(7);
  });

  /**
   * Жалоба №4 по кадру 12:19: «предлагает купить заклинание, которое даст
   * очень слабое усиление». Shifting Tide `BG32_815` — «Give a minion
   * +{0}/+{1} twice. If it's a Naga, repeat this» при `scriptData=[1,1]`:
   * на не-наге это +2/+2, на наге — +4/+4. На борде была нага (Ominous Seer
   * `BG31_330`, NAGA/DEMON), а план целил в Insatiable Ur'zul (D273).
   */
  it('условное удвоение по племени: цель усиления — нага (D273)', () => {
    const state = at('12:19:07');
    const spell = state.shopSpells.find((s) => s.cardId === 'BG32_815');
    expect(spell?.cost).toBe(0);
    expect(spell?.scriptData.slice(0, 2)).toEqual([1, 1]);
    expect(state.board.some((m) => m.cardId === 'BG31_330')).toBe(true);

    const advice = adviseTavern(state, { cards });
    const buy = advice?.recommendations.find((r) => r.spellCardId === 'BG32_815');
    expect(buy?.targetMinion?.cardId).toBe('BG31_330');
    // Удвоение читается числом: +4/+4 вместо +2/+2 — вдвое больше очков.
    expect(buy?.score ?? 0).toBeGreaterThan(3);

    const plan = spendPlan(state, { cards });
    expect(plan.steps[0]?.recommendation.targetMinion?.cardId).toBe('BG31_330');
  });
});
