import { describe, expect, it } from 'vitest';

import { FIELD_BUILD_FALLBACK, fieldBuild, notFactReasons } from '../../src/report/battle.js';
import type { FieldSnapshot } from '../../src/advisors/strength/boards.js';

/**
 * Ворота факта для расстановки — по условию за раз. Числовая часть
 * (поле хода, 2σ, ≥ 2 п.п.) проверена на живом бою part52 в battle.test.ts;
 * здесь — условия, каждое из которых снимает «однозначность».
 */
describe('расстановка: почему не факт', () => {
  const clean = { robust: true, fieldBuild: 251952, gameBuild: 251952, paidSlotSources: [] };

  it('все условия выполнены — факт', () => {
    expect(notFactReasons(clean)).toEqual([]);
  });

  it('баланс внутри группы совместимости — та же игра (250339 и 251952, builds.ts)', () => {
    expect(notFactReasons({ ...clean, gameBuild: 250339 })).toEqual([]);
  });

  it('вывод не держится на борде эпизода или проверить его нечем', () => {
    expect(notFactReasons({ ...clean, robust: false })[0]).toMatch(/разница не держится/);
    expect(notFactReasons({ ...clean, robust: null })[0]).toMatch(/состав борда в бою другой/);
  });

  it('поле другой игры и платный край — каждая причина своей строкой', () => {
    expect(notFactReasons({ ...clean, gameBuild: 253216, paidSlotSources: ['Emergency Gearblade'] })).toEqual([
      'поле бордов собрано на билде 251952, а партия — на 253216: пул карт другой',
      'тринкет Emergency Gearblade платит краю борда каждый ход — расстановка решает не только бой',
    ]);
  });

  it('карта борда или сила, усиливающая в конце хода соседей или край, снимает факт', () => {
    expect(notFactReasons({ ...clean, positionalSources: ['Sulfuras'] })).toEqual([
      'Sulfuras в конце хода усиливает соседей или край борда — порядок решает не только бой',
    ]);
  });

  it('билд поля — из снапшота, а без него — последний билд партий, из которых поле собрано', () => {
    const field = { builtAt: '2026-09-19', parts: [4], boards: [], damage: [] } as FieldSnapshot;
    expect(fieldBuild(field)).toBe(FIELD_BUILD_FALLBACK);
    expect(fieldBuild({ ...field, build: 253216 } as FieldSnapshot)).toBe(253216);
    expect(fieldBuild(null)).toBeNull();
  });
});
