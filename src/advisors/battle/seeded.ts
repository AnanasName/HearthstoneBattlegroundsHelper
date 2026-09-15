import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';

import { withSeededRandom } from '../position/rng.js';
import type { BattleSimulator } from './simulator.js';

/**
 * Симулятор, у которого одинаковый бой всегда даёт одинаковый исход.
 *
 * Зачем. Сверки (`validate:tavern`, `validate:spend`, `calibrate`) гоняли
 * несеяный Монте-Карло, и «собственный шум замера» оценивался двумя ручными
 * прогонами: 3.31 против 3.30 у покупок, 57 % против 63 % у плана. Любая
 * дельта между версиями кода тонула в этом шуме, и после каждой правки
 * приходилось спорить, эффект это или бросок. С зерном два прогона одного
 * кода совпадают до байта, а разница между версиями — это разница кода.
 *
 * Почему зерно от СОДЕРЖИМОГО боя, а не от номера вызова. Номер вызова
 * сдвигается, стоит правилу добавить или убрать одного кандидата, — и все
 * последующие бои получили бы другие броски, то есть правка «задела» бы
 * строки, к которым отношения не имеет. Хэш входа привязывает исход к самому
 * бою: изменилась только та строка, где изменился кандидат.
 *
 * Это НЕ общие случайные числа для сравнения расстановок — те замерены
 * и не работают (docs/position.md: два порядка миньонов расходятся
 * по числу бросков с первого размена). Здесь цель другая: воспроизводимость
 * замера, ровно та, ради которой зерно и оставлено в `rng.ts`.
 */
export function seededSimulator(inner: BattleSimulator, baseSeed: number): BattleSimulator {
  return {
    cards: inner.cards,
    cardsData: inner.cardsData,
    run: (input, numberOfSimulations) =>
      withSeededRandom(battleSeed(baseSeed, input, numberOfSimulations), () =>
        inner.run(input, numberOfSimulations),
      ),
  };
}

/** FNV-1a над JSON входа и числом симуляций: один бой — одно зерно. */
export function battleSeed(baseSeed: number, input: BgsBattleInfo, numberOfSimulations?: number): number {
  const text = `${JSON.stringify(input)}|${String(numberOfSimulations ?? '')}`;
  let hash = (0x811c9dc5 ^ baseSeed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash | 0;
}
