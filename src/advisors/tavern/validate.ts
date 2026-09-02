/**
 * Проверка эвристик таверны симулятором.
 *
 *   npm run validate:tavern
 *
 * Печатает то, что меряет `measureBuyQuality`: совпадает ли покупка, которую
 * советуют эвристики, с той, что реально лучше в ближайшем бою. Устройство
 * и оговорки — в buyQuality.ts, числа и выводы — в docs/tavern.md.
 */
import { createBattleSimulator } from '../battle/simulator.js';
import { loadCardIndex } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import {
  agreementRate,
  averageCost,
  measureBuyQuality,
  type BuyComparison,
} from './buyQuality.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';

// Партии текущего патча: сверка идёт симулятором, а он отражает нынешние
// правила игры. Старые партии остаются для проверки разбора лога.
// 14.08 набор расширен с part4–7 на все десять партий билда 248348:
// на 13 решающих ходах выборка была слишком мала, чтобы отличать
// системную слепоту от случайности.
const FIXTURES = CURRENT_BUILD_PARTS;

/**
 * Граница «внутри выборки / вне её». По part4–part26 эта сверка гонялась
 * после каждой правки правил — то есть числа на них смещены отбором.
 * По part27–part35 она 02.09.2026 прогнана ВПЕРВЫЕ, и это чтение вне
 * выборки одноразовое: как только правило будет принято по этим числам,
 * клетка перестанет быть чистой (та же разводка, что в `spike:arena`).
 */
const IN_SAMPLE_UNTIL = 26;

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const all: BuyComparison[] = [];
  const decisive: BuyComparison[] = [];
  const inSample: BuyComparison[] = [];
  const outOfSample: BuyComparison[] = [];
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;

  const name = (m: Minion | null): string =>
    m === null ? '?' : (cards.info(m.cardId)?.name ?? m.cardId);

  for (const part of FIXTURES) {
    const text = readFixtureGame(part);
    if (text === null) {
      console.log(`part${String(part)}: лога нет, пропущено`);
      continue;
    }
    const report = measureBuyQuality(text, { cards, simulator });
    all.push(...report.rows);
    decisive.push(...report.decisive);
    (part <= IN_SAMPLE_UNTIL ? inSample : outOfSample).push(...report.rows);
    skippedNoBattle += report.skippedNoBattle;
    skippedNoChoice += report.skippedNoChoice;

    console.log(`\n═══ part${String(part)} ═══`);
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

  const line = (label: string, rows: readonly BuyComparison[]): void => {
    if (rows.length === 0) return;
    console.log(
      `  ${label.padEnd(34)} ходов ${String(rows.length).padStart(3)}` +
        `, совпало ${(agreementRate(rows) * 100).toFixed(0).padStart(2)}%` +
        `, цена ${averageCost(rows).toFixed(2)} п.п.`,
    );
  };
  console.log('\n═══ разводка по загрязнению ═══');
  line(`part4–part${String(IN_SAMPLE_UNTIL)} (внутри выборки)`, inSample);
  line(`part${String(IN_SAMPLE_UNTIL + 1)}+ (вне выборки)`, outOfSample);
  console.log(
    '\n  Читать с оговоркой: сравнивается только ближайший бой, а покупка\n' +
      '  делается и на будущее. Совпадение не обязано быть стопроцентным.',
  );
}

main();
