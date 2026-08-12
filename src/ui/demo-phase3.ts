/**
 * Демонстрация фазы 3: советник расстановки на боях эталонной партии.
 *
 *   npm run demo:phase3
 *   npm run demo:phase3 -- data/fixtures/part2/game.log
 *   npm run demo:phase3 -- data/fixtures/part3/game.log 8
 *
 * Третий аргумент — номер хода, если интересен один бой.
 *
 * Печатается то, что игрок увидит в оверлее: как борд стоит сейчас, что
 * советуется вместо этого, насколько это лучше и стоит ли вообще трогать.
 */
import { readFileSync } from 'node:fs';

import { readBattleEpisodes, type BattleEpisode } from '../advisors/battle/episodes.js';
import { createBattleSimulator } from '../advisors/battle/simulator.js';
import { advisePosition, type PositionAdvice } from '../advisors/position/advisor.js';
import { tieRate, winRate, winRateError } from '../advisors/position/score.js';
import type { Candidate } from '../advisors/position/search.js';
import type { Minion } from '../state/types.js';

const DEFAULT_FIXTURE = 'data/fixtures/part3/game.log';

/** Короткая подпись миньона: чтобы строка расстановки читалась целиком. */
function short(m: Minion): string {
  const marks = [
    m.golden ? 'з' : '',
    m.taunt ? 'п' : '',
    m.divineShield ? 'щ' : '',
    m.poisonous || m.venomous ? 'я' : '',
    m.reborn ? 'р' : '',
    m.windfury ? 'в' : '',
  ].join('');
  return `${m.cardId}:${String(m.attack ?? '?')}/${String(m.health ?? '?')}${marks === '' ? '' : `(${marks})`}`;
}

const line = (board: readonly Minion[]): string => board.map(short).join(' → ');

function outcome(c: Candidate): string {
  const win = winRate(c.estimate) * 100;
  const tie = tieRate(c.estimate) * 100;
  const error = winRateError(c.estimate) * 100;
  return (
    `победа ${win.toFixed(1)}% ± ${error.toFixed(1)}` +
    `  ничья ${tie.toFixed(1)}%` +
    `  (${String(c.estimate.sims)} симуляций)`
  );
}

function printAdvice(episode: BattleEpisode, advice: PositionAdvice): void {
  console.log(
    `\n─── ход ${String(episode.turn)}  борд ${String(episode.playerBoard.length)}` +
      ` против ${String(episode.opponentBoard.length)}` +
      `  (в партии сыграно: ${episode.outcome})`,
  );
  console.log(`  как стоит:  ${line(episode.playerBoard)}`);
  console.log(`              ${outcome(advice.current)}`);

  console.log(
    `  перебрано ${String(advice.report.evaluated)} из ${String(advice.report.space.distinct)} расстановок` +
      `${advice.report.exhaustive ? ' (целиком)' : ''}` +
      `, ${String(advice.report.simulations)} симуляций за ${(advice.elapsedMs / 1000).toFixed(1)} с`,
  );

  const podium = advice.top.slice(0, 3);
  console.log('  лучшие:');
  for (const [i, candidate] of podium.entries()) {
    const mark = candidate.key === advice.current.key ? ' ← как стоит' : '';
    console.log(`    ${String(i + 1)}. ${line(candidate.board)}${mark}`);
    console.log(`       ${outcome(candidate)}`);
  }

  const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(1)}`;
  console.log(
    advice.improves
      ? `  ВЕРДИКТ: переставить — ${signed(advice.gain)} п.п. к оценке` +
          ` (доля побед ${signed(advice.winGain)} п.п.)`
      : `  ВЕРДИКТ: оставить как есть — разница ${signed(advice.gain)} п.п. неотличима от шума`,
  );
}

function main(): void {
  const path = process.argv[2] ?? DEFAULT_FIXTURE;
  const onlyTurn = process.argv[3] === undefined ? null : Number(process.argv[3]);

  console.log(`фикстура: ${path}`);
  const episodes = readBattleEpisodes(readFileSync(path, 'utf8')).filter(
    // На борде из одного миньона переставлять нечего.
    (e) => e.playerBoard.length > 1 && (onlyTurn === null || e.turn === onlyTurn),
  );
  if (episodes.length === 0) {
    console.log('боёв, где есть что переставлять, не нашлось');
    return;
  }

  const simulator = createBattleSimulator();

  let improved = 0;
  let totalGain = 0;
  const started = Date.now();

  for (const episode of episodes) {
    const advice = advisePosition(episode, { simulator });
    printAdvice(episode, advice);
    if (advice.improves) {
      improved += 1;
      totalGain += advice.gain;
    }
  }

  console.log(`\n─── итог по ${String(episodes.length)} боям`);
  console.log(`  советует переставить: ${String(improved)}`);
  console.log(
    `  суммарный выигрыш там, где советует: ${totalGain.toFixed(1)} п.п.` +
      (improved > 0 ? ` (в среднем ${(totalGain / improved).toFixed(1)})` : ''),
  );
  console.log(`  всего времени: ${((Date.now() - started) / 1000).toFixed(1)} с`);
}

main();
