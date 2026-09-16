import { describe, expect, it } from 'vitest';

import { effectOnBoard, spellEffect } from '../../../src/advisors/tavern/advisor.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { minion } from '../../minions.js';

/**
 * Усиление, у которого ЧИСЛО своих названо фразой: «Give four friendly
 * minions +{0} Attack» (Hostile Bounty `BG33_812`, Healthy Bounty `BG33_811`,
 * part55). Тексты — дословно снапшот, с приклеенным золотым вариантом (D206).
 *
 * По логу part55 (17:19:17, блок PLAY `BG33_812`) один Hostile Bounty дал
 * +4 атаки четырём разным сущностям; советник считал одно тело — «+4 статов».
 */
const cards = createCardIndex([
  {
    id: 'HOSTILE',
    name: 'Hostile Bounty',
    type: 'Battleground_spell',
    cost: 0,
    text: 'Give four friendly minions +{0} Attack.4Give four friendly minions +{0}/+{1}.',
  },
  {
    id: 'HEALTHY',
    name: 'Healthy Bounty',
    type: 'Battleground_spell',
    cost: 0,
    text: 'Give four friendly minions +{1} Health.4Give four friendly minions +{0}/+{1}.',
  },
  {
    id: 'MUG',
    name: 'Menagerie-like',
    type: 'Battleground_spell',
    cost: 0,
    text: 'Give 3 friendly minions of different types +1/+1.',
  },
  { id: 'RING', name: 'Shiny Ring', type: 'Battleground_spell', cost: 0, text: 'Give your minions +{0}/+{1}.' },
]);

const bodies = (n: number) =>
  Array.from({ length: n }, (_, i) => minion(i + 1, { cardId: 'X', attack: 5, health: 5, zonePos: i + 1 }));

describe('усиление «Give four friendly minions» (part55)', () => {
  it('число тел читается из фразы и ограничено бордом', () => {
    const hostile = spellEffect('HOSTILE', [4, 0], cards);
    expect(hostile?.stats).toBe(4);
    expect(hostile?.boardWide).toBe(true);
    expect(hostile?.boardCount).toBe(4);

    const six = effectOnBoard(hostile!, bodies(6), undefined, cards);
    expect(six.bodies).toBe(4);
    expect(six.effect.stats).toBe(16);
    expect(six.wide).toBe(true);

    const two = effectOnBoard(hostile!, bodies(2), undefined, cards);
    expect(two.bodies).toBe(2);
    expect(two.effect.stats).toBe(8);
  });

  it('Healthy Bounty — то же число, здоровье вторым плейсхолдером', () => {
    const healthy = spellEffect('HEALTHY', [0, 3], cards);
    expect(healthy?.stats).toBe(3);
    expect(healthy?.boardCount).toBe(4);
    expect(effectOnBoard(healthy!, bodies(7), undefined, cards).effect.stats).toBe(12);
  });

  it('«весь борд» без числа — прежний множитель, «разных типов» — не число', () => {
    const ring = spellEffect('RING', [1, 1], cards);
    expect(ring?.boardCount).toBeNull();
    expect(effectOnBoard(ring!, bodies(7), undefined, cards).bodies).toBe(7);

    const mug = spellEffect('MUG', [], cards);
    expect(mug?.boardCount ?? null).toBeNull();
    expect(mug?.boardWide ?? false).toBe(false);
  });
});
