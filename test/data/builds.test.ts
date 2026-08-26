import { describe, expect, it } from 'vitest';

import { BUILD_GROUPS, compatibleBuilds, sameGameBuild } from '../../src/data/builds.js';

/**
 * Таблица совместимости билдов. Правило отбора партий — «одна игра»,
 * а не «один номер билда»: баланс и багфиксы меняют номер, оставляя пул
 * карт прежним (26.08.2026, решение игрока по патчноуту и по нулю
 * незнакомых карт в его партии).
 */
describe('совместимость билдов', () => {
  it('баланс-патч и его предшественник — одна игра', () => {
    expect(sameGameBuild(248348, 250339)).toBe(true);
    expect(sameGameBuild(250339, 248348)).toBe(true);
  });

  it('контентный патч остаётся чужим', () => {
    // 246003 в группу не входит: на нём калибровка ухудшалась вдвое.
    expect(sameGameBuild(246003, 250339)).toBe(false);
    expect(sameGameBuild(246003, 248348)).toBe(false);
  });

  it('билд вне таблицы совместим только сам с собой', () => {
    expect(sameGameBuild(999999, 999999)).toBe(true);
    expect(sameGameBuild(999999, 248348)).toBe(false);
    expect([...compatibleBuilds(999999)]).toEqual([999999]);
  });

  it('неизвестный билд не приравнивается к известному', () => {
    expect(sameGameBuild(null, 248348)).toBe(false);
    expect(sameGameBuild(248348, null)).toBe(false);
    // Две записи без билда — одинаково слепые, но и это не «та же игра»
    // с чем-то известным; равными считаются только между собой.
    expect(sameGameBuild(null, null)).toBe(true);
  });

  it('группы не пересекаются: билд принадлежит одной игре, а не двум', () => {
    const seen = new Set<number>();
    for (const group of BUILD_GROUPS) {
      for (const build of group) {
        expect(seen.has(build)).toBe(false);
        seen.add(build);
      }
    }
  });
});
