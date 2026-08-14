/**
 * Замеры под «расстановку против поля» — счёт против всех виденных бордов,
 * а не против одного следующего противника.
 *
 *   npm run spike:field
 *
 * Три вопроса, которые надо закрыть числами до кода:
 *
 *   1. сколько ходов советник молчит при цели «один противник» и сколько
 *      виденных бордов было на руках в эти самые ходы — это и есть цена
 *      нынешнего молчания и сырьё для цели-поля;
 *   2. сколько стоит оценка одного кандидата против K бордов: постоянная
 *      часть вызова симулятора (~8.5 мс) множится на K, и надо знать,
 *      сколько кандидатов отбор успевает просмотреть в тот же бюджет;
 *   3. находит ли поиск с целью-полем лучшую расстановку — сверка с полным
 *      перебором, где эталон посчитан по тому же полю.
 *
 * Скрипт остаётся в репозитории: числа перепроверяются при смене версии
 * симулятора и при смене патча игры.
 */
import { readFileSync } from 'node:fs';

import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { readTavernTurns } from '../tavern/turns.js';
import { arrangementSpace } from './arrangements.js';
import { resolveOpponent } from './opponent.js';
import { withSeededRandom } from './rng.js';
import { EMPTY_ESTIMATE, mergeEstimates, objectiveOf, toEstimate } from './score.js';
import { searchArrangement, type Evaluate } from './search.js';
import type { GameState, Minion } from '../../state/types.js';

const FIXTURES = [
  'data/fixtures/part4/game.log',
  'data/fixtures/part5/game.log',
  'data/fixtures/part6/game.log',
  'data/fixtures/part7/game.log',
] as const;

interface SeenBoardPicture {
  readonly playerId: number;
  readonly board: readonly Minion[];
  readonly staleTurns: number;
}

function seenBoards(state: GameState): SeenBoardPicture[] {
  return Object.entries(state.lastSeenBoards)
    .filter(([, board]) => board.length > 0)
    .map(([id, board]) => ({
      playerId: Number(id),
      board,
      staleTurns: Math.max(0, state.turn - (state.lastSeenBoardTurns[Number(id)] ?? state.turn)),
    }));
}

function setupFor(state: GameState, opponent: SeenBoardPicture): BattleSetup {
  if (state.hero === null) throw new Error('точка решения без героя');
  return {
    turn: state.turn,
    playerBoard: state.board,
    opponentBoard: opponent.board,
    playerHero: state.hero,
    techLevel: state.techLevel,
    anomalyCardId: state.anomalyCardId,
    globalInfo: state.globalInfo,
    playerTrinketDbfIds:
      state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
    opponentTrinketDbfIds: state.trinketsByPlayer[opponent.playerId] ?? [],
  };
}

/** Раздача симуляций по бордам: поровну, остаток первым. */
function splitSims(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

function main(): void {
  // ─── 1. цена молчания: ходы без цели и виденные борды в них ────────────────
  console.log('=== молчание цели «один противник» по точкам решения ===');
  console.log('  фикстура  ход  борд  видено бордов  давность  цель-один');

  let silentWithBoards = 0;
  let totalDecisionTurns = 0;
  let singleUsable = 0;
  const candidates: {
    fixture: string;
    state: GameState;
    seen: SeenBoardPicture[];
    singleUsable: boolean;
  }[] = [];

  for (const path of FIXTURES) {
    const short = path.split('/')[2] ?? path;
    const turns = readTavernTurns(readFileSync(path, 'utf8'));
    for (const { turn, state } of turns) {
      if (state.board.length < 2) continue; // переставлять нечего
      totalDecisionTurns += 1;
      const single = resolveOpponent(state);
      const seen = seenBoards(state);
      if (single.usable) singleUsable += 1;
      else if (seen.length > 0) silentWithBoards += 1;
      if (seen.length > 0)
        candidates.push({ fixture: short, state, seen, singleUsable: single.usable });

      const staleness =
        seen.length === 0
          ? '—'
          : `${String(Math.min(...seen.map((s) => s.staleTurns)))}–${String(Math.max(...seen.map((s) => s.staleTurns)))}`;
      console.log(
        `  ${short.padEnd(8)} ${String(turn).padStart(4)}  ${String(state.board.length).padStart(4)}` +
          `  ${String(seen.length).padStart(13)}  ${staleness.padStart(8)}  ${single.usable ? 'есть' : 'НЕТ'}`,
      );
    }
  }
  console.log(
    `\n  точек решения с бордом ≥2: ${String(totalDecisionTurns)};` +
      ` цель-один есть: ${String(singleUsable)};` +
      ` молчит, хотя борды видены: ${String(silentWithBoards)}\n`,
  );

  // ─── 2. стоимость кандидата против K бордов ────────────────────────────────
  // Бой для замера — точка решения, где цель-поле реально нужна: советник
  // сейчас молчит (цели-один нет), борд ≥5. Из таких — с самым большим полем.
  // Первый заход мерил на ходу 15, где цель-один и так есть, — там поле из
  // семи бордов уже нетипично для момента, когда советник заговорит.
  const applicable = candidates.filter((c) => c.state.board.length >= 5 && !c.singleUsable);
  const pool = applicable.length > 0 ? applicable : candidates.filter((c) => c.state.board.length >= 5);
  const chosen = pool.reduce((best, c) => (c.seen.length > best.seen.length ? c : best));
  console.log(
    `=== стоимость кандидата против K бордов ===\n` +
      `  замер на ${chosen.fixture}, ход ${String(chosen.state.turn)}: свой борд ${String(chosen.state.board.length)},` +
      ` видено ${String(chosen.seen.length)} бордов по ${chosen.seen.map((s) => String(s.board.length)).join('/')} миньонов`,
  );

  const simulator = createBattleSimulator();
  const bases = chosen.seen.map((opponent) => toBattleInfo(setupFor(chosen.state, opponent), 1));
  const playerBoard = chosen.state.board;

  const SCREEN_SIMS = 150;
  // Прогрев: первый вызов платит за JIT втрое, мерить его нельзя.
  for (const base of bases) simulator.run(withPlayerBoard(base, playerBoard), 200);

  const reps = 15;
  for (let k = 1; k <= bases.length; k += 1) {
    const sims = splitSims(SCREEN_SIMS, k);
    const started = process.hrtime.bigint();
    for (let r = 0; r < reps; r += 1) {
      for (let i = 0; i < k; i += 1) {
        const base = bases[i];
        const n = sims[i];
        if (base !== undefined && n !== undefined && n > 0)
          simulator.run(withPlayerBoard(base, playerBoard), n);
      }
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6 / reps;
    const budget = 2500; // отборочный бюджет поиска
    console.log(
      `  K=${String(k)}: ${ms.toFixed(1)} мс на кандидата (${String(SCREEN_SIMS)} симуляций суммарно)` +
        ` — в отборочные ${String(budget)} мс влезает ~${String(Math.floor(budget / ms))} кандидатов`,
    );
  }

  // ─── 3. поиск с целью-полем против полного перебора по полю ────────────────
  // Эталон дорог, поэтому борд для сверки ужимается до 5 миньонов: 120
  // расстановок посчитать честно, а механика поиска от размера не зависит.
  const truthBoard = playerBoard.slice(0, Math.min(5, playerBoard.length));
  const space = arrangementSpace(truthBoard);
  const K = bases.length;
  const TRUTH_SIMS = 600;
  console.log(
    `\n=== поиск против перебора по полю (${String(space.distinct)} расстановок` +
      ` x ${String(K)} бордов x ${String(TRUTH_SIMS)}) ===`,
  );

  const truthStarted = Date.now();
  const truth = new Map<string, number>();
  for (const arrangement of space.iterate()) {
    let merged = EMPTY_ESTIMATE;
    for (const [i, base] of bases.entries()) {
      const result = withSeededRandom(90_000 + i, () =>
        simulator.run(withPlayerBoard(base, arrangement.board), TRUTH_SIMS),
      );
      merged = mergeEstimates(merged, toEstimate(result));
    }
    truth.set(arrangement.key, objectiveOf(merged, 'winRate'));
  }
  const sortedTruth = [...truth.values()].sort((a, b) => b - a);
  console.log(
    `  эталон за ${((Date.now() - truthStarted) / 1000).toFixed(0)} с:` +
      ` лучшая ${((sortedTruth[0] ?? 0) * 100).toFixed(1)}%,` +
      ` худшая ${((sortedTruth[sortedTruth.length - 1] ?? 0) * 100).toFixed(1)}%,` +
      ` размах ${(((sortedTruth[0] ?? 0) - (sortedTruth[sortedTruth.length - 1] ?? 0)) * 100).toFixed(1)} п.п.`,
  );

  // Оценщик поля — ровно то, что будет делать советник: симуляции кандидата
  // делятся между бордами поровну, счётчики складываются.
  const evaluateField: Evaluate = (board, sims, seed) => {
    let merged = EMPTY_ESTIMATE;
    const parts = splitSims(sims, bases.length);
    for (const [i, base] of bases.entries()) {
      const n = parts[i];
      if (n === undefined || n <= 0) continue;
      const result = withSeededRandom(seed * 31 + i, () =>
        simulator.run(withPlayerBoard(base, board), n),
      );
      merged = mergeEstimates(merged, toEstimate(result));
    }
    return merged;
  };

  for (const seed of [1, 2, 3]) {
    const searchStarted = Date.now();
    const report = searchArrangement(truthBoard, evaluateField, { seed });
    const ms = Date.now() - searchStarted;
    const pick = report.top[0];
    const pickTruth = pick === undefined ? 0 : (truth.get(pick.key) ?? 0);
    const rank = sortedTruth.filter((v) => v > pickTruth).length + 1;
    console.log(
      `  зерно ${String(seed)}: ранг рекомендации ${String(rank)} из ${String(space.distinct)},` +
        ` отставание ${(((sortedTruth[0] ?? 0) - pickTruth) * 100).toFixed(1)} п.п.,` +
        ` ${String(report.evaluated)} кандидатов, ${String(report.simulations)} симуляций за ${(ms / 1000).toFixed(1)} с`,
    );
  }

  // Отдельно: охват отбора на ПОЛНОМ борде против всего поля — то, что
  // случится в живой игре на семи миньонах.
  console.log('\n=== охват на полном борде против всего поля ===');
  const fullStarted = Date.now();
  const fullReport = searchArrangement(playerBoard, evaluateField, { seed: 1 });
  console.log(
    `  борд ${String(playerBoard.length)}: ${String(fullReport.evaluated)} кандидатов из ${String(fullReport.space.distinct)},` +
      ` ${String(fullReport.simulations)} симуляций за ${((Date.now() - fullStarted) / 1000).toFixed(1)} с`,
  );
}

main();
