import { describe, expect, it } from 'vitest';

import { createCardIndex } from '../../src/data/cards.js';
import { baseCardId, offPoolShopCards, poolFingerprint, poolMinionIds } from '../../src/data/pool.js';

/**
 * Пул миньонов по снапшоту карт (`src/data/pool.ts`). Партия и поле бордов
 * сверяются по пулу, а не по номеру билда: 22.09.2026 пул сменился посреди
 * билда 251952 (part67 → part68).
 */
const minion = (id: string, techLevel: number, isBaconPool: boolean) => ({
  id,
  name: id,
  type: 'Minion',
  techLevel,
  isBaconPool,
});

const cards = createCardIndex([
  minion('HOPEBRINGER', 5, true),
  minion('DUNE_DWELLER', 1, true),
  minion('DUNE_DWELLER_G', 1, true),
  minion('MOLTEN_ROCK', 1, false),
  { id: 'DARK_PARADOX_T5', name: 'Dark Paradox', type: 'Minion', isBaconPool: false },
  { id: 'SPELL', name: 'SPELL', type: 'Spell', techLevel: 1, isBaconPool: true },
]);

describe('пул миньонов', () => {
  it('только миньоны с флагом пула, без золотых копий', () => {
    expect([...poolMinionIds(cards)].sort()).toEqual(['DUNE_DWELLER', 'HOPEBRINGER']);
  });

  it('золотой суффикс снимается: золотая — та же карта пула', () => {
    expect(baseCardId('DUNE_DWELLER_G')).toBe('DUNE_DWELLER');
    expect(baseCardId('BG36_364')).toBe('BG36_364');
  });

  it('карта витрины вне пула называет другой пул', () => {
    expect(offPoolShopCards(['HOPEBRINGER', 'MOLTEN_ROCK', 'MOLTEN_ROCK', 'DUNE_DWELLER_G'], cards)).toEqual([
      'MOLTEN_ROCK',
    ]);
    expect(offPoolShopCards(['HOPEBRINGER', 'DUNE_DWELLER'], cards)).toEqual([]);
  });

  it('незнакомая снапшоту карта витрины — тоже вне пула', () => {
    expect(offPoolShopCards(['BG99_001'], cards)).toEqual(['BG99_001']);
  });

  it('ушедшая из пула карта и жетон в снапшоте неотличимы — различает только метка пула из лога', () => {
    // Firestone стирает ушедшей карте и флаг, и тир: Molten Rock `BGS_127`
    // в снапшоте 24.09 выглядит как жетон Dark Paradox `BG36_360t5`. Поэтому
    // на вход идут только карты, помеченные игрой (`seenShopPoolCardIds`),
    // и всё, что пришло, — улика.
    expect(offPoolShopCards(['DARK_PARADOX_T5'], cards)).toEqual(['DARK_PARADOX_T5']);
  });

  it('отпечаток зависит от состава пула, а не от прочих карт', () => {
    const same = createCardIndex([
      minion('HOPEBRINGER', 5, true),
      minion('DUNE_DWELLER', 1, true),
      minion('OTHER_TOKEN', 2, false),
    ]);
    const rotated = createCardIndex([minion('HOPEBRINGER', 5, true), minion('MOLTEN_ROCK', 1, true)]);
    expect(poolFingerprint(same)).toBe(poolFingerprint(cards));
    expect(poolFingerprint(rotated)).not.toBe(poolFingerprint(cards));
  });
});
