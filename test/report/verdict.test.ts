import { describe, expect, it } from 'vitest';

import { fieldFitsGame, fieldPoolReason, notFactReasons } from '../../src/report/battle.js';
import type { FieldSnapshot } from '../../src/advisors/strength/boards.js';
import { createCardIndex } from '../../src/data/cards.js';
import { poolFingerprint } from '../../src/data/pool.js';

/**
 * Ворота факта для расстановки — по условию за раз. Числовая часть
 * (поле хода, 2σ, ≥ 2 п.п.) проверена на живом бою part52 в battle.test.ts;
 * здесь — условия, каждое из которых снимает «однозначность».
 */
describe('расстановка: почему не факт', () => {
  const clean = { robust: true, fieldPool: null, paidSlotSources: [] };

  it('все условия выполнены — факт', () => {
    expect(notFactReasons(clean)).toEqual([]);
  });

  it('вывод не держится на борде эпизода или проверить его нечем', () => {
    expect(notFactReasons({ ...clean, robust: false })[0]).toMatch(/разница не держится/);
    expect(notFactReasons({ ...clean, robust: null })[0]).toMatch(/состав борда в бою другой/);
  });

  it('поле другой игры и платный край — каждая причина своей строкой', () => {
    expect(
      notFactReasons({ ...clean, fieldPool: 'партия сыграна на другом пуле карт', paidSlotSources: ['Emergency Gearblade'] }),
    ).toEqual([
      'партия сыграна на другом пуле карт',
      'тринкет Emergency Gearblade платит краю борда каждый ход — расстановка решает не только бой',
    ]);
  });

  it('карта борда или сила, усиливающая в конце хода соседей или край, снимает факт', () => {
    expect(notFactReasons({ ...clean, positionalSources: ['Sulfuras'] })).toEqual([
      'Sulfuras в конце хода усиливает соседей или край борда — порядок решает не только бой',
    ]);
  });
});

/**
 * Поле и партия сверяются по ПУЛУ, а не по номеру билда (D304): 22.09 пул
 * сменился посреди билда 251952 (part67 | part68), а 253216 его не тронул.
 */
describe('поле бордов и пул партии', () => {
  const cards = createCardIndex([
    { id: 'HOPEBRINGER', name: 'Hopebringer', type: 'Minion', techLevel: 5, isBaconPool: true },
    { id: 'MOLTEN_ROCK', name: 'Molten Rock', type: 'Minion', techLevel: 1, isBaconPool: false },
    { id: 'SAND_SWIRLER', name: 'Sand Swirler', type: 'Minion', techLevel: 3, isBaconPool: false },
  ]);
  const field: FieldSnapshot = {
    builtAt: '2026-09-25T18:00:00.000Z',
    pool: poolFingerprint(cards),
    parts: [68],
    boards: [],
    damage: [],
  };
  const deps = { field, cards, gameOffPool: [] as string[] };

  it('поле нынешнего пула и партия без карт вне пула — та же игра', () => {
    expect(fieldPoolReason(deps)).toBeNull();
    expect(fieldFitsGame(deps)).toBe(true);
  });

  it('партия другого пула: причина называет карты её витрины', () => {
    const reason = fieldPoolReason({ ...deps, gameOffPool: ['MOLTEN_ROCK', 'SAND_SWIRLER'] });
    expect(reason).toBe(
      'партия сыграна на другом пуле карт: в её витрине были Molten Rock, Sand Swirler — их в нынешнем пуле нет',
    );
    expect(fieldFitsGame({ ...deps, gameOffPool: ['MOLTEN_ROCK'] })).toBe(false);
  });

  it('поле другого пула или без отпечатка (собрано до D304) — не та игра', () => {
    expect(fieldPoolReason({ ...deps, field: { ...field, pool: 'другой' } })).toMatch(/на другом пуле карт/);
    const old: FieldSnapshot = { builtAt: field.builtAt, parts: field.parts, boards: [], damage: [] };
    expect(fieldPoolReason({ ...deps, field: old })).toMatch(/собрано 2026-09-25 на другом пуле карт/);
  });

  it('поля нет — причины нет, но и «той же игры» нет', () => {
    expect(fieldPoolReason({ ...deps, field: null })).toBeNull();
    expect(fieldFitsGame({ ...deps, field: null })).toBe(false);
  });
});
