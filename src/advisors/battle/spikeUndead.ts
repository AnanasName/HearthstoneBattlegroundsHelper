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
 *
 * ## Другие счётчики (17.09.2026)
 *
 *   npm run spike:undead -- --fields=BeetleAttackBuff,BeetleHealthBuff <логи…>
 *
 * `--fields` называет поля `globalInfo`, которые вынимаются во второй
 * ветви; по умолчанию — три поля нежити. Отдельно печатается подвыборка
 * боёв, где хоть одно из полей было задано: на остальных ветви одинаковы
 * по построению, и их шум разбавляет разницу.
 */
import { readFileSync } from 'node:fs';

import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { readBattleEpisodes, type Outcome } from './episodes.js';
import { toBattleInfo } from './mapper.js';
import { createBattleSimulator } from './simulator.js';

const SIMULATIONS = 3000;
const OUTLIER = 0.05;
const UNDEAD_FIELDS = ['UndeadAttackBonus', 'UndeadHealthBonus', 'EternalKnightsDeadThisGame'];

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
  /** У кого в бою задано хоть одно из вынимаемых полей. */
  touched: 'none' | 'own' | 'opponent' | 'both';
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
      ` (обещано ${(meanPredicted * 100).toFixed(1)} %, факт ${(actual * 100).toFixed(1)} %)` +
      `  Brier ${brier.toFixed(3)}` +
      `  выбросов ${String(outliers.length)}`,
  );
  for (const r of outliers) {
    console.log(`      выброс: ${r.fixture} ход ${String(r.turn)} — факт ${r.outcome}, дано ${(r.p * 100).toFixed(1)}%`);
  }
}

function main(): void {
  const simulator = createBattleSimulator();
  const args = process.argv.slice(2);
  const fieldsArg = args.find((a) => a.startsWith('--fields='));
  const stripped = fieldsArg === undefined ? UNDEAD_FIELDS : fieldsArg.slice('--fields='.length).split(',');
  const fixtures = args.filter((a) => !a.startsWith('--'));

  const withRows: Row[] = [];
  const withoutRows: Row[] = [];

  for (const path of fixtures) {
    const short = path.split('/')[2] ?? path;
    for (const episode of readBattleEpisodes(readFileSync(path, 'utf8'))) {
      const base = toBattleInfo(episode, SIMULATIONS);
      const has = (side: typeof base.playerBoard.player): boolean =>
        stripped.some((key) => (side.globalInfo as Record<string, number | undefined>)[key] !== undefined);
      const own = has(base.playerBoard.player);
      const theirs = has(base.opponentBoard.player);
      const touched = own && theirs ? 'both' : own ? 'own' : theirs ? 'opponent' : 'none';

      const withResult = simulator.run(base);
      withRows.push({
        outcome: episode.outcome,
        won: withResult.wonPercent / 100,
        p: predicted(withResult, episode.outcome),
        turn: episode.turn,
        fixture: short,
        touched,
      });

      // Та же постановка боя, из которой вынуты ровно названные поля.
      const bare = toBattleInfo(episode, SIMULATIONS);
      for (const side of [bare.playerBoard.player, bare.opponentBoard.player]) {
        const gi = side.globalInfo as Record<string, number>;
        for (const key of stripped) delete gi[key];
      }
      const withoutResult = simulator.run(bare);
      withoutRows.push({
        outcome: episode.outcome,
        won: withoutResult.wonPercent / 100,
        p: predicted(withoutResult, episode.outcome),
        turn: episode.turn,
        fixture: short,
        touched,
      });
    }
  }

  if (withRows.length === 0) {
    console.log('боёв не найдено');
    return;
  }
  console.log(`\nA/B полей ${stripped.join(', ')} по фикстурам: ${fixtures.join(', ')}\n`);
  report('БЕЗ счётчиков', withoutRows);
  report('СО счётчиками', withRows);
  for (const [label, keep] of [
    ['где поле задано хоть у кого-то', (t: Row['touched']) => t !== 'none'],
    ['только у нас', (t: Row['touched']) => t === 'own'],
    ['только у соперника', (t: Row['touched']) => t === 'opponent'],
    ['у обеих сторон', (t: Row['touched']) => t === 'both'],
  ] as const) {
    const without = withoutRows.filter((r) => keep(r.touched));
    if (without.length === 0) continue;
    console.log(`\nбои, ${label}:`);
    report('БЕЗ счётчиков', without);
    report('СО счётчиками', withRows.filter((r) => keep(r.touched)));
  }
}

main();
