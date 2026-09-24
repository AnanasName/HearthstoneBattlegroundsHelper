import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part73Game } from '../fixtures.js';

/** Tavern Coin: «Gain 1 Gold», цена 1. */
const TAVERN_COIN = 'BG28_810';

/**
 * part73 — Ониксия (24.09.2026), 2-е место. Фактура партии — в `test/fixtures.ts`.
 *
 * Вопрос игрока дословно: «На последних ходах мне советовало много
 * заклинаний к покупке, не уверен, что с моим столом они сильно лучше
 * обновления». Ход таверны 16 (ход 31): золото 13, борд полон и огромен
 * (Goldrinn 174/35, Skitterer 146/16), в витрине Tavern Coin за 1 —
 * и верхний совет «КУПИТЬ Tavern Coin за 1 (0.5) ← золото про запас».
 *
 * Монета без прибыли возвращает ровно то, что за неё отдано: в этот ход
 * она не меняет ничего. А обновление, которое советник сам выставляет
 * верхним при «делать нечего, а золото есть» (part11), ставилось только
 * над советом «ничего» — и монета с теми же 0.5 его заслоняла (D291).
 */
describe('part73: монета без прибыли не заслоняет обновление', () => {
  let cards: CardIndex;
  let turns: TavernTurn[];

  beforeAll(async () => {
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(part73Game(), createBreather());
  }, 600_000);

  const at = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`нет точки решения на ходу ${String(turn)}`);
    return found.state;
  };

  it('ход 31 воспроизводится: золото 13, борд полон, Tavern Coin за 1 в витрине', () => {
    const state = at(31);
    expect(state.gold).toBe(13);
    expect(state.board).toHaveLength(7);
    expect(state.shopSpells.map((s) => [s.cardId, s.cost])).toEqual([[TAVERN_COIN, 1]]);
  });

  it('ход 31: верхний совет — обновление, монета остаётся в списке ниже', () => {
    const recs = adviseTavern(at(31), { cards })?.recommendations ?? [];
    expect(recs[0]?.action).toBe('reroll');
    const coin = recs.findIndex((r) => r.spellCardId === TAVERN_COIN);
    expect(coin).toBeGreaterThan(0);
  });

  it('ход 31: план начинает с обновления, а не с монеты', () => {
    // Игрок в этот ход трижды обновил витрину первым делом и монету
    // не брал (review part73, ход 31).
    const [first] = spendPlan(at(31), { cards }).steps.map((s) => s.recommendation);
    expect(first?.action).toBe('reroll');
  });
});
