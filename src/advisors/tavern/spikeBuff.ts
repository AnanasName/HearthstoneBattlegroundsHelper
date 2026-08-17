/**
 * Замер: при равной сумме статов — атака или здоровье?
 *
 *   npm run spike:buff
 *
 * ## Зачем
 *
 * Модальное заклинание «Choose One» предлагает две ветви одной цены:
 * Alliance Flag — «+3/+1» (Allied Mace) против «+1/+3» (Allied Buckler).
 * По нашей шкале ценности они РОВНО равны: статы считаются суммой
 * (`perStatPoint` на атаку и здоровье одинаков), и разделить их нечем.
 * Игрок part19 (ход 7) на это и указал: советник назвал заклинание
 * и цель, а какой эффект брать — промолчал.
 *
 * Выдумывать правило («атака всегда лучше») нельзя — это было бы чужое
 * мнение под видом факта. Зато есть симулятор и шестнадцать партий
 * текущего билда: вопрос решается замером.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Если повесить на ту же цель, что выбирают правила, +3/+1
 * или +1/+3, что даёт лучший исход БЛИЖАЙШЕГО боя?
 *
 * **Точки.** Все точки решения таверны (`readTavernTurns`) партий билда
 * 248348, где есть непустой борд, есть цель боя (следующий противник
 * или поле виденных бордов) и есть кому достаться баффу.
 *
 * **Мера.** Парная разность на точку: исход (победа + половина ничьей)
 * с «+3/+1» минус исход с «+1/+3». Число симуляций на сторону — 2000,
 * зерно фиксировано, поле делится поровну (как в живом режиме).
 *
 * **Приёмка.** Направление принимается, если |среднее| превышает ДВЕ
 * стандартные ошибки среднего по точкам. Иначе — `null`: советник честно
 * называет обе ветви и оставляет выбор игроку. Порог объявлен здесь
 * до прогона; минимальный различимый эффект печатается рядом
 * с результатом, чтобы «не нашли» нельзя было спутать с «не могли найти».
 *
 * **Оговорки, тоже до прогона.**
 *  - меряется только БЛИЖАЙШИЙ бой, а усиление остаётся навсегда;
 *    для статов это честнее, чем для экономики, но не полно;
 *  - точки решения — начало хода, а заклинание играется в конце; борд
 *    к тому моменту бывает больше;
 *  - разделение 3/1 взято от Alliance Flag; на другие суммы результат
 *    переносится по смыслу, а не по замеру.
 */
import { readFileSync } from 'node:fs';

import { loadCardIndex } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import { endOfTurnAuraGains, withEndOfTurnAuras } from '../battle/endOfTurn.js';
import { toBattleInfo, withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import { withSeededRandom } from '../position/rng.js';
import { buffTarget } from './advisor.js';
import { readTavernTurns } from './turns.js';

const FIXTURES = [
  'data/fixtures/part4/game.log',
  'data/fixtures/part5/game.log',
  'data/fixtures/part6/game.log',
  'data/fixtures/part7/game.log',
  'data/fixtures/part8/game.log',
  'data/fixtures/part9/game.log',
  'data/fixtures/part10/game.log',
  'data/fixtures/part11/game.log',
  'data/fixtures/part12/game.log',
  'data/fixtures/part13/game.log',
  'data/fixtures/part14/game.log',
  'data/fixtures/part15/game.log',
  'data/fixtures/part16/game.log',
  'data/fixtures/part17/game.log',
  'data/fixtures/part18/game.log',
  'data/fixtures/part19/game.log',
  'data/fixtures/part20/game.log',
  'data/fixtures/part21/game.log',
] as const;

/** Разделение статов замера: сумма одна, розданы по-разному. */
const SPLIT = { attack: 3, health: 1 } as const;
const SIMULATIONS = 2000;
const SEED = 20_260_817;

function buffed(board: readonly Minion[], target: Minion, atk: number, hp: number): Minion[] {
  return board.map((m) =>
    m.entityId === target.entityId
      ? {
          ...m,
          attack: (m.attack ?? 0) + atk,
          health: (m.health ?? 1) + hp,
          maxHealth: m.maxHealth === null ? null : m.maxHealth + hp,
        }
      : m,
  );
}

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const diffs: { readonly turn: number; readonly diff: number }[] = [];
  let skipped = 0;

  for (const path of FIXTURES) {
    const turns = readTavernTurns(readFileSync(path, 'utf8'));
    let used = 0;

    for (const { state } of turns) {
      const question = battleQuestion(state);
      const target = buffTarget(state, { cards });
      if (question === null || target === null || state.board.length === 0) {
        skipped += 1;
        continue;
      }

      const auraGains = endOfTurnAuraGains(state.board, simulator.cards);
      const bases = question.setups.map((s) => toBattleInfo(s, 1));
      const per = Math.max(1, Math.floor(SIMULATIONS / bases.length));

      const run = (atk: number, hp: number): number => {
        const board = withEndOfTurnAuras(buffed(state.board, target, atk, hp), auraGains);
        let sum = 0;
        for (const [i, base] of bases.entries()) {
          const r = withSeededRandom(SEED + i, () =>
            simulator.run(withPlayerBoard(base, board), per),
          );
          sum += r.wonPercent + r.tiedPercent / 2;
        }
        return sum / bases.length;
      };

      diffs.push({
        turn: state.turn,
        diff: run(SPLIT.attack, SPLIT.health) - run(SPLIT.health, SPLIT.attack),
      });
      used += 1;
    }

    console.log(`${(path.split('/')[2] ?? path).padEnd(8)} точек ${String(used).padStart(3)}`);
  }

  if (diffs.length === 0) {
    console.log('точек не нашлось');
    return;
  }

  const summary = (
    rows: readonly { readonly diff: number }[],
  ): { n: number; mean: number; se: number; moved: number } => {
    const n = rows.length;
    const mean = rows.reduce((a, b) => a + b.diff, 0) / n;
    const variance = rows.reduce((a, b) => a + (b.diff - mean) ** 2, 0) / Math.max(1, n - 1);
    return { n, mean, se: Math.sqrt(variance / n), moved: rows.filter((r) => Math.abs(r.diff) > 0.05).length };
  };

  const all = summary(diffs);

  console.log('\n═══ итог ═══');
  console.log(`  точек решения:            ${String(all.n)} (пропущено ${String(skipped)})`);
  console.log(`  из них разность ненулевая: ${String(all.moved)}`);
  console.log(
    `  среднее (+${String(SPLIT.attack)}/+${String(SPLIT.health)} минус ` +
      `+${String(SPLIT.health)}/+${String(SPLIT.attack)}): ${all.mean.toFixed(3)} п.п.`,
  );
  console.log(`  стандартная ошибка:       ${all.se.toFixed(3)} п.п.`);
  console.log(`  минимальный различимый:   ${(2 * all.se).toFixed(3)} п.п. (порог приёмки)`);
  console.log(
    `\n  ВЕРДИКТ: ${
      Math.abs(all.mean) > 2 * all.se
        ? all.mean > 0
          ? 'при равной сумме брать АТАКУ (buffSplitPreference: attack)'
          : 'при равной сумме брать ЗДОРОВЬЕ (buffSplitPreference: health)'
        : 'разницы не видно — buffSplitPreference остаётся null'
    }`,
  );

  // Диагностика, НЕ предрегистрированная и на вердикт не влияющая: ход 1
  // в наших сверках — другой режим (бой 1×1, исходы насыщены), и он умеет
  // тянуть на себя почти всю сумму квадратов. Печатается, чтобы «не нашли»
  // нельзя было спутать с «нашли, но спрятали в шуме первого хода».
  const firstTurn = diffs.filter((d) => d.turn === 1).length;
  const late = summary(diffs.filter((d) => d.turn > 1));
  console.log(
    `\n  диагностика (не предрегистрирована), без хода 1: ${String(late.n)} точек ` +
      `(ход 1 дал ${String(firstTurn)}: до первого боя цели нет, и такие точки` +
      ' до замера не доходят вовсе), ' +
      `среднее ${late.mean.toFixed(3)} п.п. при пороге ${(2 * late.se).toFixed(3)}`,
  );
  console.log(
    '\n  Оговорки — в шапке файла: считается только ближайший бой, точка\n' +
      '  решения снята в начале хода, разделение 3/1 взято от Alliance Flag.',
  );
}

main();
