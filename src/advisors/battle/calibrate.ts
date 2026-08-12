/**
 * Калибровка симулятора на боях с известным исходом.
 *
 *   npm run calibrate
 *
 * ТЗ формулирует DoD фазы 2 как «фактический исход не является выбросом».
 * По одному бою это почти нельзя опровергнуть: если симулятор дал поражению
 * 30%, а мы проиграли, это ничего не доказывает. Поэтому здесь считаются
 * агрегатные метрики по всем боям всех фикстур:
 *
 *   - калибровка: средняя предсказанная вероятность победы против фактической
 *     доли побед. У честного предсказателя они близки;
 *   - Brier score: средний квадрат ошибки вероятности, чем меньше тем лучше.
 *     0.25 — уровень «всегда говорить 50%»;
 *   - доля боёв, где фактический исход получил меньше 5% вероятности.
 *     Это и есть «выбросы» из формулировки ТЗ.
 */
import { readFileSync } from 'node:fs';

import { AllCardsService } from '@firestone-hs/reference-data';
import { simulateBattle } from '@firestone-hs/simulate-bgs-battle';
import { CardsData } from '@firestone-hs/simulate-bgs-battle/dist/cards/cards-data.js';
import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { readBattleEpisodes, type BattleEpisode, type Outcome } from './episodes.js';
import { toBattleInfo } from './mapper.js';

const FIXTURES = [
  'data/fixtures/part2/game.log',
  'data/fixtures/part3/game.log',
] as const;

const SIMULATIONS = 3000;
/** Порог, ниже которого исход считаем выбросом. */
const OUTLIER = 0.05;

function predicted(result: SimulationResult, outcome: Outcome): number {
  switch (outcome) {
    case 'won':
      return result.wonPercent / 100;
    case 'lost':
      return result.lostPercent / 100;
    case 'tied':
      return result.tiedPercent / 100;
  }
}

function run(
  episode: BattleEpisode,
  cards: AllCardsService,
  cardsData: CardsData,
): SimulationResult {
  const generator = simulateBattle(toBattleInfo(episode, SIMULATIONS), cards, cardsData);
  let step = generator.next();
  while (step.done !== true) step = generator.next();
  return step.value;
}

function main(): void {
  const cards = new AllCardsService();
  cards.initializeCardsDbFromCards(
    JSON.parse(readFileSync('data/cards/cards_enUS.json', 'utf8')) as never,
  );
  const cardsData = new CardsData(cards, false);
  cardsData.inititialize();

  const rows: {
    fixture: string;
    episode: BattleEpisode;
    result: SimulationResult;
    p: number;
  }[] = [];

  for (const path of FIXTURES) {
    const episodes = readBattleEpisodes(readFileSync(path, 'utf8'));
    const short = path.split('/')[2] ?? path;
    console.log(`\n═══ ${short}: боёв ${String(episodes.length)} ═══`);
    console.log('  ход   мой борд  враг   факт        предсказано (побед/ничьих/поражений)');

    for (const episode of episodes) {
      const result = run(episode, cards, cardsData);
      const p = predicted(result, episode.outcome);
      rows.push({ fixture: short, episode, result, p });

      console.log(
        `  ${String(episode.turn).padStart(3)}` +
          `  ${String(episode.playerBoard.length).padStart(8)}` +
          `  ${String(episode.opponentBoard.length).padStart(4)}` +
          `  ${episode.outcome.padEnd(10)}` +
          `  ${result.wonPercent.toFixed(0).padStart(3)}% / ` +
          `${result.tiedPercent.toFixed(0).padStart(3)}% / ` +
          `${result.lostPercent.toFixed(0).padStart(3)}%` +
          `   вероятность факта ${(p * 100).toFixed(0).padStart(3)}%`,
      );
    }
  }

  if (rows.length === 0) {
    console.log('\nбоёв не найдено');
    return;
  }

  // ─── агрегаты ──────────────────────────────────────────────────────────────
  const wins = rows.filter((r) => r.episode.outcome === 'won').length;
  const meanPredictedWin =
    rows.reduce((sum, r) => sum + r.result.wonPercent / 100, 0) / rows.length;
  const actualWinRate = wins / rows.length;

  const brier =
    rows.reduce((sum, r) => {
      const actual = r.episode.outcome === 'won' ? 1 : 0;
      const diff = r.result.wonPercent / 100 - actual;
      return sum + diff * diff;
    }, 0) / rows.length;

  const outliers = rows.filter((r) => r.p < OUTLIER);

  console.log(`\n═══ итог по ${String(rows.length)} боям ═══`);
  console.log(`  фактическая доля побед:      ${(actualWinRate * 100).toFixed(1)}%`);
  console.log(`  средняя предсказанная:       ${(meanPredictedWin * 100).toFixed(1)}%`);
  console.log(
    `  расхождение калибровки:      ${(Math.abs(meanPredictedWin - actualWinRate) * 100).toFixed(1)} п.п.`,
  );
  console.log(`  Brier score:                 ${brier.toFixed(3)}  (0.25 = «всегда 50%»)`);
  console.log(
    `  исходов с вероятностью <${String(OUTLIER * 100)}%: ${String(outliers.length)} из ${String(rows.length)}`,
  );

  if (outliers.length > 0) {
    console.log('\n  выбросы — там симулятор ошибся сильнее всего:');
    for (const r of outliers) {
      console.log(
        `    ${r.fixture} ход ${String(r.episode.turn).padStart(2)}: факт ${r.episode.outcome}` +
          `, дано ${(r.p * 100).toFixed(1)}%` +
          `  (борды ${String(r.episode.playerBoard.length)} на ${String(r.episode.opponentBoard.length)})`,
      );
    }
  }
}

main();
