import { describe, expect, it } from 'vitest';

import { createBgStats, loadBgStats, MIN_DATA_POINTS } from '../../src/data/bgStats.js';

/**
 * Справочник статистики мест — снапшот открытых данных Firestone.
 *
 * Здесь проверяется разбор и границы честности: малые выборки и скины.
 * Сам снапшот — данные, его числа не проверяются (они меняются с патчем);
 * проверяется только, что реальный файл читается и непуст.
 */
describe('статистика мест из снапшота', () => {
  const heroRaw = {
    heroStats: [
      {
        heroCardId: 'BG_HERO_A',
        dataPoints: 10_000,
        totalOffered: 30_000,
        totalPicked: 10_000,
        averagePosition: 3.85,
      },
      // Малую выборку показывать нельзя: среднее по полусотне партий — шум.
      { heroCardId: 'BG_HERO_RARE', dataPoints: MIN_DATA_POINTS - 1, averagePosition: 1.01 },
    ],
  };
  const trinketRaw = {
    trinketStats: [
      {
        trinketCardId: 'BG_TRINKET_A',
        dataPoints: 5000,
        pickRate: 0.4,
        averagePlacement: 3.62,
      },
    ],
  };

  it('разбор: герой и тринкет находятся, малая выборка отфильтрована', () => {
    const stats = createBgStats(heroRaw, trinketRaw);
    expect(stats.hero('BG_HERO_A')?.averagePosition).toBe(3.85);
    expect(stats.hero('BG_HERO_A')?.pickRate).toBeCloseTo(1 / 3, 5);
    expect(stats.hero('BG_HERO_RARE')).toBeNull();
    expect(stats.trinket('BG_TRINKET_A')?.averagePlacement).toBe(3.62);
    expect(stats.trinket('НЕТ_ТАКОГО')).toBeNull();
  });

  it('скин героя приводится к базовой карте (part13: BG27_HERO_801_SKIN_A)', () => {
    const stats = createBgStats(heroRaw, trinketRaw);
    expect(stats.hero('BG_HERO_A_SKIN_C')?.averagePosition).toBe(3.85);
  });

  it('реальный снапшот читается и непуст', () => {
    const stats = loadBgStats();
    expect(stats.heroCount).toBeGreaterThan(50);
    expect(stats.trinketCount).toBeGreaterThan(100);
    // Сильвана из part14 — герой текущего патча, статистика по ней есть.
    expect(stats.hero('BG23_HERO_306')).not.toBeNull();
  });
});
