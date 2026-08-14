import { describe, expect, it } from 'vitest';

import { createCardIndex } from '../../src/data/cards.js';
import { CardsFreshness, STALE_CARDS_THRESHOLD } from '../../src/live/freshness.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { board, minion } from '../minions.js';

/**
 * Предупреждение «снапшот отстал от патча».
 *
 * Фон незнакомых карт при свежем снапшоте замерен на всех тринадцати
 * партиях билда 248348: ровно ноль. Порог 3 — выше любого шума
 * и на порядок ниже реального отставания (41 незнакомая, замер 13.08).
 */

const cards = createCardIndex([
  { id: 'KNOWN_1', name: 'Знакомый', techLevel: 1, races: [], isBaconPool: true },
]);

function state(patch: Partial<GameState> = {}): GameState {
  return { ...EMPTY_STATE, phase: 'tavern', turn: 3, buildNumber: 248348, ...patch };
}

describe('свежесть снапшота карт', () => {
  it('молчит, пока незнакомых меньше порога', () => {
    const freshness = new CardsFreshness(cards);
    expect(
      freshness.update(state({ shop: [minion(1, { cardId: 'NEW_1' }), minion(2, { cardId: 'KNOWN_1' })] })),
    ).toBeNull();
    expect(freshness.update(state({ board: [minion(3, { cardId: 'NEW_2' })] }))).toBeNull();
  });

  it('на пороге говорит вслух один раз, с билдом и командами обновления', () => {
    const freshness = new CardsFreshness(cards);
    const shop = board([1, 2, 3], {}).map((m, i) => ({ ...m, cardId: `NEW_${String(i)}` }));

    const warning = freshness.update(state({ shop }));
    expect(warning).toContain(`${String(STALE_CARDS_THRESHOLD)} незнакомых`);
    expect(warning).toContain('248348');
    expect(warning).toContain('update:cards');
    expect(warning).toContain('update:bgstats');

    // Второй раз не повторяется — интерфейс не заспамлен.
    expect(freshness.update(state({ shop }))).toBeNull();
  });

  it('копии одной незнакомой карты — одна карта, а не три', () => {
    const freshness = new CardsFreshness(cards);
    const copies = board([1, 2, 3]).map((m) => ({ ...m, cardId: 'NEW_SAME' }));
    expect(freshness.update(state({ shop: copies }))).toBeNull();
  });

  it('новая партия начинает счёт заново', () => {
    const freshness = new CardsFreshness(cards);
    const shop = board([1, 2, 3]).map((m, i) => ({ ...m, cardId: `NEW_${String(i)}` }));
    expect(freshness.update(state({ shop }))).not.toBeNull();

    freshness.reset();
    expect(freshness.update(state({ shop }))).not.toBeNull();
  });
});
