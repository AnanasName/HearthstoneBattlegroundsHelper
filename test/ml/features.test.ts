import { describe, expect, it } from 'vitest';

import { extractFeatures, FEATURE_NAMES, MISSING_PLACE } from '../../src/ml/features.js';
import { EMPTY_STATE, type GameState, type Hero } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Признаки точки решения — предрегистрированный список docs/ml.md.
 * Тесты держат ПОРЯДОК и ПОЛИТИКУ ПРОПУСКОВ: и то и другое входит
 * в предрегистрацию, и молчаливая смена любого из них сделала бы
 * записанные числа замера числами про другую процедуру.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'BG33_HERO_001',
  health: 20,
  damage: 5,
  armor: 3,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function state(patch: Partial<GameState>): GameState {
  return { ...EMPTY_STATE, phase: 'tavern', hero: HERO, ...patch };
}

describe('признаки предсказания места', () => {
  it('семь признаков, порядок совпадает с именами', () => {
    const s = state({
      turn: 7, // четвёртый ход таверны
      techLevel: 3,
      finalPlace: 6,
      wonLastCombat: true,
      board: [
        ...board([1], { attack: 4, health: 5 }),
        ...board([2], { attack: 2, health: 3 }),
      ],
    });
    const features = extractFeatures(s);
    expect(features).toHaveLength(FEATURE_NAMES.length);
    expect(features).toEqual([4, 3, 20 - 5 + 3, 6, Math.log1p(4 + 5 + 2 + 3), 1, 0]);
  });

  it('пропуски: место — середина таблицы, бой — ноль с индикатором, герой без записи — ноль', () => {
    const s = state({
      turn: 1,
      hero: null,
      finalPlace: null,
      wonLastCombat: null,
      board: [],
    });
    expect(extractFeatures(s)).toEqual([1, 1, 0, MISSING_PLACE, 0, 0, 1]);
  });

  it('герой с непрочитанным здоровьем даёт ноль, а не «минус урон плюс броня»', () => {
    const s = state({
      turn: 1,
      hero: { ...HERO, health: null },
      finalPlace: 4,
    });
    expect(extractFeatures(s)[2]).toBe(0);
  });

  it('проигранный бой — минус один, не ноль, и индикатор «ещё без побед» молчит', () => {
    const s = state({ turn: 3, wonLastCombat: false, finalPlace: 5 });
    expect(extractFeatures(s)[5]).toBe(-1);
    expect(extractFeatures(s)[6]).toBe(0);
  });

  it('миньон без прочитанных статов считается нулём, а не валит счёт', () => {
    const s = state({
      turn: 3,
      finalPlace: 2,
      board: board([1], { attack: null, health: null }),
    });
    expect(extractFeatures(s)[4]).toBe(0);
  });
});
