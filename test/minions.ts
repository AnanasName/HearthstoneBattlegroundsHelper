import type { Minion } from '../src/state/types.js';

/**
 * Миньон для тестов.
 *
 * Одна фабрика на все тесты сознательно: пока их было три, добавление поля
 * в `Minion` ломало каждую по отдельности, и соблазн был не добавлять поле,
 * а обойтись. Здесь же поле дописывается один раз.
 *
 * Умолчания выбраны нейтральными: ничего не выигрывает и не проигрывает
 * само по себе, всё интересное тест задаёт явно.
 */
export function minion(entityId: number, patch: Partial<Minion> = {}): Minion {
  return {
    entityId,
    cardId: `CARD_${String(entityId)}`,
    zonePos: entityId,
    attack: 3,
    health: 4,
    taunt: false,
    divineShield: false,
    poisonous: false,
    venomous: false,
    reborn: false,
    windfury: false,
    stealth: false,
    golden: false,
    frozen: false,
    maxHealth: 4,
    techLevel: 3,
    enchantments: [],
    scriptData: [null, null, null, null, null, null],
    tags: {},
    // Кнопки покупки у тестового миньона нет: цена — правило игры.
    buyCost: null,
    ...patch,
  };
}

/** Борд из миньонов с указанными идентификаторами, в этом порядке. */
export function board(ids: readonly number[], patch: Partial<Minion> = {}): Minion[] {
  return ids.map((id) => minion(id, patch));
}
