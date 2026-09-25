import { describe, expect, it } from 'vitest';

import { activationRules } from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { createCardIndex } from '../../../src/data/cards.js';
import { EMPTY_STATE, type GameState } from '../../../src/state/types.js';
import { minion } from '../../minions.js';

/**
 * Шкала цены активации (D308, part79). Тексты — дословно снапшот:
 * Suspicious Prisonguard `BG36_345`, Private Investigator `BG36_509`.
 */
const cards = createCardIndex([
  {
    id: 'PRISONGUARD',
    name: 'Suspicious Prisonguard',
    type: 'Minion',
    techLevel: 1,
    attack: 3,
    health: 3,
    races: [],
    text: '<b>Activate ({2}):</b> Give another minion +{0}/+{1}.',
  },
  {
    id: 'INVESTIGATOR',
    name: 'Private Investigator',
    type: 'Minion',
    techLevel: 2,
    races: [],
    text: '<b>Activate ({0}):</b> Gain {1} Gold next turn.',
  },
  { id: 'BODY', name: 'Тело', type: 'Minion', techLevel: 1, races: [] },
]);
const deps = { cards };
const { perStatPoint } = DEFAULT_TAVERN_RULES.value;
const { goldPointValue } = DEFAULT_TAVERN_RULES;

function state(patch: Partial<GameState> = {}): GameState {
  return { ...EMPTY_STATE, phase: 'tavern', turn: 7, techLevel: 3, gold: 1, goldTotal: 6, ...patch };
}

const prisonguard = minion(10, {
  cardId: 'PRISONGUARD',
  attack: 3,
  health: 3,
  scriptData: [3, 3, 1, null, null, null],
  tags: { HAS_ACTIVATE_POWER: 1, INTERACTABLE_OBJECT_COST: 1 },
});
const body = minion(11, { cardId: 'BODY', attack: 6, health: 8 });

describe('цена нажатия активации (D308)', () => {
  it('статы своему борду — очки без вычета цены, как у заклинания-усиления', () => {
    const [rec] = activationRules(state({ board: [body, prisonguard] }), deps);
    expect(rec?.targetMinion?.entityId).toBe(body.entityId);
    expect(rec?.score).toBeCloseTo(6 * perStatPoint, 9);
  });

  it('«Give ANOTHER minion» без другого миньона на борде — совета нет', () => {
    // part49, ход 1: после снятия вычета план покупал Prisonguard на пустой
    // борд и тут же жал его активацию без цели.
    expect(activationRules(state({ board: [prisonguard] }), deps)).toEqual([]);
  });

  it('обмен на золото вычитает цену по-прежнему', () => {
    const investigator = minion(12, {
      cardId: 'INVESTIGATOR',
      scriptData: [1, 2, null, null, null, null],
      tags: { HAS_ACTIVATE_POWER: 1, INTERACTABLE_OBJECT_COST: 1 },
    });
    const [rec] = activationRules(state({ board: [investigator] }), deps);
    expect(rec?.score).toBeCloseTo((2 - 1) * goldPointValue, 9);
  });
});
