/**
 * Проверка эвристик таверны симулятором.
 *
 *   npm run validate:tavern
 *
 * Печатает то, что меряет `measureBuyQuality`: совпадает ли покупка, которую
 * советуют эвристики, с той, что реально лучше в ближайшем бою. Устройство
 * и оговорки — в buyQuality.ts, числа и выводы — в docs/tavern.md.
 */
import { readFileSync } from 'node:fs';

import { createBattleSimulator } from '../battle/simulator.js';
import { loadCardIndex } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import {
  agreementRate,
  averageCost,
  measureBuyQuality,
  type BuyComparison,
} from './buyQuality.js';

// Партии текущего патча: сверка идёт симулятором, а он отражает нынешние
// правила игры. Старые партии остаются для проверки разбора лога.
// 14.08 набор расширен с part4–7 на все десять партий билда 248348:
// на 13 решающих ходах выборка была слишком мала, чтобы отличать
// системную слепоту от случайности.
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
] as const;

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const all: BuyComparison[] = [];
  const decisive: BuyComparison[] = [];
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;

  const name = (m: Minion | null): string =>
    m === null ? '?' : (cards.info(m.cardId)?.name ?? m.cardId);

  for (const path of FIXTURES) {
    const report = measureBuyQuality(readFileSync(path, 'utf8'), { cards, simulator });
    all.push(...report.rows);
    decisive.push(...report.decisive);
    skippedNoBattle += report.skippedNoBattle;
    skippedNoChoice += report.skippedNoChoice;

    console.log(`\n═══ ${path.split('/')[2] ?? path} ═══`);
    console.log('  ход  канд.  совет эвристики        лучшее по симулятору    цена  разброс  исход');
    for (const r of report.rows) {
      const cost = r.bestOutcome - r.heuristicOutcome;
      console.log(
        `  ${String(r.turn).padStart(3)}` +
          `  ${String(r.candidates).padStart(5)}` +
          `  ${name(r.heuristicPick.minion).slice(0, 20).padEnd(20)}` +
          `  ${(r.agreed ? '— то же' : name(r.simulatorPick.minion)).slice(0, 20).padEnd(22)}` +
          `  ${(cost < 0.05 ? '—' : cost.toFixed(1)).padStart(4)}` +
          `  ${r.spread.toFixed(1).padStart(7)}` +
          `  ${r.heuristicOutcome.toFixed(0).padStart(4)}%`,
      );
    }
  }

  console.log('\n═══ итог ═══');
  if (all.length === 0) {
    console.log('  сравнивать было нечего');
    return;
  }
  console.log(`  ходов со сравнением:        ${String(all.length)}`);
  console.log(
    `  совет совпал с симулятором: ${String(all.filter((r) => r.agreed).length)}` +
      ` (${(agreementRate(all) * 100).toFixed(0)}%)`,
  );
  console.log(`  средняя цена расхождения:   ${averageCost(all).toFixed(2)} п.п.`);
  console.log(`  выбор что-то решал на:      ${String(decisive.length)} ходах`);
  if (decisive.length > 0) {
    console.log(
      `    там совпал:               ${String(decisive.filter((r) => r.agreed).length)}` +
        ` (${(agreementRate(decisive) * 100).toFixed(0)}%)` +
        `, средняя цена ${averageCost(decisive).toFixed(1)} п.п.`,
    );
  }
  console.log(`  пропущено без боя следом:   ${String(skippedNoBattle)}`);
  console.log(`  пропущено без выбора:       ${String(skippedNoChoice)}`);
  console.log(
    '\n  Читать с оговоркой: сравнивается только ближайший бой, а покупка\n' +
      '  делается и на будущее. Совпадение не обязано быть стопроцентным.',
  );
}

main();
