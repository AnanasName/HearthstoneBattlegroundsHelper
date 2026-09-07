/**
 * A/B счётчиков нежити: та же калибровка, тот же процесс, одни эпизоды.
 *
 *   npm run spike:undead -- data/fixtures/part50/game.log [ещё логи…]
 *
 * ## Зачем отдельный прибор, а не два прогона `calibrate`
 *
 * Сравнивать «до» и «после» двумя прогонами на разном коде нечестно дважды:
 * в дереве работают соседние сессии, а несеяный Монте-Карло даёт свой
 * разброс. Здесь обе ветви считаются в ОДНОМ процессе на одних и тех же
 * эпизодах и различаются ровно тем, что снимается на входе в симулятор, —
 * значит разница это правка, а не сборка.
 *
 * ## Что этот замер показал (07.09.2026, part50)
 *
 * На самой партии (16 боёв): расхождение калибровки 21.9 → 3.2 п.п.,
 * Brier 0.284 → 0.110, выбросов 3 → 0. На стандартном наборе part4–part7
 * ветви ТОЖДЕСТВЕННЫ по построению: полей там нет, и обе получают один
 * вход. А на партиях, где нежить у СОПЕРНИКА (77 боёв), прибор поймал
 * то, ради чего и заводился: односторонняя правка (только своя надбавка)
 * делала ХУЖЕ — 5.5 → 6.2 п.п., — и лишь симметричная дала 1.5 п.п.
 * при Brier 0.091.
 */
import { readFileSync } from 'node:fs';

import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { readBattleEpisodes, type Outcome } from './episodes.js';
import { toBattleInfo } from './mapper.js';
import { createBattleSimulator } from './simulator.js';

const SIMULATIONS = 3000;
const OUTLIER = 0.05;
const STRIPPED = ['UndeadAttackBonus', 'UndeadHealthBonus', 'EternalKnightsDeadThisGame'];

function predicted(result: SimulationResult, outcome: Outcome): number {
  if (outcome === 'won') return result.wonPercent / 100;
  if (outcome === 'lost') return result.lostPercent / 100;
  return result.tiedPercent / 100;
}

interface Row {
  outcome: Outcome;
  won: number;
  p: number;
  turn: number;
  fixture: string;
}

function report(label: string, rows: readonly Row[]): void {
  const wins = rows.filter((r) => r.outcome === 'won').length;
  const meanPredicted = rows.reduce((s, r) => s + r.won, 0) / rows.length;
  const actual = wins / rows.length;
  const brier =
    rows.reduce((s, r) => {
      const a = r.outcome === 'won' ? 1 : 0;
      return s + (r.won - a) ** 2;
    }, 0) / rows.length;
  const outliers = rows.filter((r) => r.p < OUTLIER);
  console.log(
    `${label.padEnd(18)} боёв ${String(rows.length).padStart(3)}` +
      `  расхождение ${(Math.abs(meanPredicted - actual) * 100).toFixed(1).padStart(5)} п.п.` +
      `  Brier ${brier.toFixed(3)}` +
      `  выбросов ${String(outliers.length)}`,
  );
  for (const r of outliers) {
    console.log(`      выброс: ${r.fixture} ход ${String(r.turn)} — факт ${r.outcome}, дано ${(r.p * 100).toFixed(1)}%`);
  }
}

function main(): void {
  const simulator = createBattleSimulator();
  const fixtures = process.argv.slice(2);

  const withRows: Row[] = [];
  const withoutRows: Row[] = [];

  for (const path of fixtures) {
    const short = path.split('/')[2] ?? path;
    for (const episode of readBattleEpisodes(readFileSync(path, 'utf8'))) {
      const base = toBattleInfo(episode, SIMULATIONS);

      const withResult = simulator.run(base);
      withRows.push({
        outcome: episode.outcome,
        won: withResult.wonPercent / 100,
        p: predicted(withResult, episode.outcome),
        turn: episode.turn,
        fixture: short,
      });

      // Та же постановка боя, из которой вынуты ровно два поля.
      const stripped = toBattleInfo(episode, SIMULATIONS);
      for (const side of [stripped.playerBoard.player, stripped.opponentBoard.player]) {
        const gi = side.globalInfo as Record<string, number>;
        for (const key of STRIPPED) delete gi[key];
      }
      const withoutResult = simulator.run(stripped);
      withoutRows.push({
        outcome: episode.outcome,
        won: withoutResult.wonPercent / 100,
        p: predicted(withoutResult, episode.outcome),
        turn: episode.turn,
        fixture: short,
      });
    }
  }

  if (withRows.length === 0) {
    console.log('боёв не найдено');
    return;
  }
  console.log(`\nA/B по фикстурам: ${fixtures.join(', ')}\n`);
  report('БЕЗ счётчиков', withoutRows);
  report('СО счётчиками', withRows);
}

main();
