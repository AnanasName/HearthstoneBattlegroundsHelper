/**
 * Проверка плана трат хода перебором корзин.
 *
 *   npm run validate:spend
 *
 * Отвечает на вопрос, отложенный в CLAUDE.md: довольно ли жадной цепочки
 * правил или нужен полный оптимизатор трат. Устройство и оговорки —
 * в spendQuality.ts, числа и выводы — в docs/tavern.md.
 */
import { readFileSync } from 'node:fs';

import { createBattleSimulator } from '../battle/simulator.js';
import { loadCardIndex } from '../../data/cards.js';
import {
  averageGoldLeft,
  measureSpendQuality,
  spendAgreement,
  spendCost,
  type SpendComparison,
} from './spendQuality.js';

const FIXTURES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map(
  (n) => `data/fixtures/part${String(n)}/game.log`,
);

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const all: SpendComparison[] = [];
  const decisive: SpendComparison[] = [];
  const sameShape: SpendComparison[] = [];
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;

  for (const path of FIXTURES) {
    const report = measureSpendQuality(readFileSync(path, 'utf8'), { cards, simulator });
    all.push(...report.rows);
    decisive.push(...report.decisive);
    sameShape.push(...report.sameShapeRows);
    skippedNoBattle += report.skippedNoBattle;
    skippedNoChoice += report.skippedNoChoice;

    console.log(`\n═══ ${path.split('/')[2] ?? path} ═══`);
    console.log('  ход  наборов  план  лучший  цена  разброс  подъём (план/лучший)  остаток (план/лучший)');
    for (const r of report.rows) {
      const cost = r.bestOutcome - r.planOutcome;
      console.log(
        `  ${String(r.turn).padStart(3)}` +
          `  ${String(r.baskets).padStart(7)}` +
          `  ${r.planOutcome.toFixed(0).padStart(4)}%` +
          `  ${r.bestOutcome.toFixed(0).padStart(6)}%` +
          `  ${(cost < 0.05 ? '—' : cost.toFixed(1)).padStart(4)}` +
          `  ${r.spread.toFixed(1).padStart(7)}` +
          `  ${`${r.planLevelUp ? 'да' : 'нет'}/${r.bestLevelUp ? 'да' : 'нет'}`.padStart(20)}` +
          `  ${`${String(r.planGoldLeft)}/${String(r.bestGoldLeft)}`.padStart(20)}`,
      );
    }
  }

  console.log('\n═══ итог ═══');
  if (all.length === 0) {
    console.log('  сравнивать было нечего');
    return;
  }
  console.log(`  ходов со сравнением:          ${String(all.length)}`);
  console.log(
    `  план совпал с лучшим набором: ${String(all.filter((r) => r.agreed).length)}` +
      ` (${(spendAgreement(all) * 100).toFixed(0)}%)`,
  );
  console.log(`  средняя цена расхождения:     ${spendCost(all).toFixed(2)} п.п.`);
  console.log(`  выбор что-то решал на:        ${String(decisive.length)} ходах`);
  if (decisive.length > 0) {
    console.log(
      `    там совпал:                 ${String(decisive.filter((r) => r.agreed).length)}` +
        ` (${(spendAgreement(decisive) * 100).toFixed(0)}%)` +
        `, средняя цена ${spendCost(decisive).toFixed(1)} п.п.`,
    );
  }
  console.log(
    `  золота сгорает: у плана ${averageGoldLeft(all, (r) => r.planGoldLeft).toFixed(2)},` +
      ` у лучшего набора ${averageGoldLeft(all, (r) => r.bestGoldLeft).toFixed(2)}`,
  );
  const shapeDecisive = sameShape.filter((r) => r.spread > 5);
  console.log(
    `\n  ВНУТРИ ФОРМЫ (та же длина набора, то же решение о подъёме):` +
      ` ходов ${String(sameShape.length)},` +
      ` совпало ${(spendAgreement(sameShape) * 100).toFixed(0)}%,` +
      ` цена ${spendCost(sameShape).toFixed(2)} п.п.`,
  );
  console.log(
    `    из них решающих ${String(shapeDecisive.length)}:` +
      ` совпало ${(spendAgreement(shapeDecisive) * 100).toFixed(0)}%,` +
      ` цена ${spendCost(shapeDecisive).toFixed(1)} п.п.`,
  );
  console.log(
    `  пропущено: без боя следом ${String(skippedNoBattle)},` +
      ` без выбора или вне перебора ${String(skippedNoChoice)}`,
  );
  console.log(
    '\n  Читать с оговоркой: сравнивается только ближайший бой, и купленные\n' +
      '  тела дописываются в хвост борда без поиска расстановки. Поэтому\n' +
      '  главный итог — строка «внутри формы»: там у наборов одна длина\n' +
      '  и одно решение о подъёме, и вопрос сводится к «те ли тела куплены».',
  );
}

main();
