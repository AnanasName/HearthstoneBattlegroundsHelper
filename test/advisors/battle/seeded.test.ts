import { describe, expect, it } from 'vitest';

import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { battleSeed, seededSimulator } from '../../../src/advisors/battle/seeded.js';
import type { BattleSimulator } from '../../../src/advisors/battle/simulator.js';

/**
 * Поддельный симулятор: исход — это `Math.random()`. Пакетный `withRng`
 * подменяет именно его (и собственный источник пакета), поэтому
 * детерминизм обёртки проверяется без загрузки справочника карт.
 */
const fake: BattleSimulator = {
  cards: null as never,
  cardsData: null as never,
  run: () => ({ wonPercent: Math.random() * 100 }) as SimulationResult,
};

const battle = (attack: number): BgsBattleInfo =>
  ({ playerBoard: { board: [{ attack }] }, opponentBoard: { board: [] } }) as unknown as BgsBattleInfo;

describe('симулятор с зерном от содержимого боя', () => {
  it('один и тот же бой даёт один и тот же исход', () => {
    const sim = seededSimulator(fake, 1);
    expect(sim.run(battle(3), 100).wonPercent).toBe(sim.run(battle(3), 100).wonPercent);
  });

  it('другой бой — другой бросок', () => {
    const sim = seededSimulator(fake, 1);
    expect(sim.run(battle(3), 100).wonPercent).not.toBe(sim.run(battle(4), 100).wonPercent);
  });

  it('исход не зависит от порядка вызовов — лишний кандидат не сдвигает остальных', () => {
    const a = seededSimulator(fake, 1);
    const b = seededSimulator(fake, 1);
    const alone = a.run(battle(5), 100).wonPercent;
    b.run(battle(9), 100);
    b.run(battle(1), 100);
    expect(b.run(battle(5), 100).wonPercent).toBe(alone);
  });

  it('зерно прогона меняет все броски', () => {
    expect(seededSimulator(fake, 1).run(battle(3), 100).wonPercent).not.toBe(
      seededSimulator(fake, 2).run(battle(3), 100).wonPercent,
    );
  });

  it('вне обёртки случайность не залипает', () => {
    seededSimulator(fake, 1).run(battle(3), 100);
    expect(fake.run(battle(3), 100).wonPercent).not.toBe(fake.run(battle(3), 100).wonPercent);
  });

  it('число симуляций входит в зерно', () => {
    expect(battleSeed(1, battle(3), 100)).not.toBe(battleSeed(1, battle(3), 200));
  });
});
