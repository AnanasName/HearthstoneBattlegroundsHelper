/**
 * Дамп «кандидат покупки → исход ближайшего боя» для замера статистики карт.
 *
 *   npm run measure:cardstats -- --stats <снапшот> --out <файл.jsonl>
 *   npm run measure:cardstats -- --fixtures part5 --out <файл.jsonl>
 *
 * Замер описан целиком в docs/cardstats.md; предрегистрация закоммичена
 * ДО первого запуска этого скрипта.
 *
 * ## Зачем дамп, а не два прогона сверки
 *
 * Статистика карт по построению замера входит только в РАНЖИРОВАНИЕ покупок
 * между собой, поэтому состав кандидатов и борды, с которыми они выходят
 * в бой, от веса не зависят вовсе. Значит исходы достаточно посчитать ОДИН
 * раз: любой вес, любой срез и любой порог проверяются потом по дампу
 * арифметикой, без единой новой симуляции. На ходах, где вес не сменил
 * выбор, парная разность равна строго нулю, а не «нулю в пределах шума», —
 * ровно та ловушка, из-за которой сравнивать конфигурации по агрегатам
 * `validate:tavern` (79% против 80%) нельзя.
 *
 * Статистика в советник здесь НЕ подаётся: правила прогоняются штатные,
 * а `statGain` едет лишней колонкой.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { withSeededRandom } from '../position/rng.js';
import { loadCardStats, statGainOf, CARD_STATS_PATH } from '../../data/cardStats.js';
import { loadCardIndex } from '../../data/cards.js';
import { readFileSync } from 'node:fs';
import { minionValue } from './advisor.js';
import { enumerateBuyDecisions } from './buyQuality.js';
import { DEFAULT_TAVERN_RULES } from './rules.js';

/** Те же партии, что в сверке: 13 партий билда 248348. */
const FIXTURES = [
  'part4',
  'part5',
  'part6',
  'part7',
  'part8',
  'part9',
  'part10',
  'part11',
  'part12',
  'part13',
  'part14',
  'part15',
  'part16',
] as const;

/** Предрегистрировано: вдвое против сверки — ловим слабую связь. */
const SIMULATIONS = 4000;
/** Кап слагаемого, мест: ±2σ остатка снапшота. */
const CAP_PLACES = 0.7164;

/**
 * Зерно из ключа строки: FNV-1a.
 *
 * Зёрна у кандидатов РАЗНЫЕ (общие случайные числа проекту уже мерились:
 * 0.9×, выигрыша нет) и одинаковые между прогонами — дамп воспроизводим.
 */
function seedOf(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Ноль как зерно бессмысленен для ГПСЧ — сдвигаем в 1..2^32-1.
  return hash === 0 ? 1 : hash;
}

function arg(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function main(): void {
  const argv = process.argv.slice(2);
  const statsPath = arg(argv, 'stats') ?? CARD_STATS_PATH;
  const outPath = arg(argv, 'out') ?? 'data/dataset/cardstats-dump.jsonl';
  const only = arg(argv, 'fixtures');
  const fixtures = only === undefined ? FIXTURES : (only.split(',') as readonly string[]);

  const cards = loadCardIndex();
  const stats = loadCardStats(cards, statsPath);
  const simulator = createBattleSimulator();
  console.log(
    `карт: ${cards.size.toLocaleString('ru-RU')}; статистика: ${String(stats.size)} миньонов, ` +
      `σ остатка ${stats.sigmaResidual.toFixed(4)}`,
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, '', 'utf8');

  let rows = 0;
  let turns = 0;
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;
  const started = Date.now();

  for (const fixture of fixtures) {
    const text = readFileSync(`data/fixtures/${fixture}/game.log`, 'utf8');
    const enumeration = enumerateBuyDecisions(text, { cards, simulator }, DEFAULT_TAVERN_RULES);
    skippedNoBattle += enumeration.skippedNoBattle;
    skippedNoChoice += enumeration.skippedNoChoice;

    for (const decision of enumeration.decisions) {
      turns += 1;
      const { state } = decision;

      decision.candidates.forEach((buy, index) => {
        const board = decision.boards[index] ?? [];
        const key = `${fixture}|${String(decision.turn)}|${String(index)}|${buy.minion.cardId}|${String(buy.minion.entityId)}`;
        const result = withSeededRandom(seedOf(key), () =>
          simulator.run(withPlayerBoard(decision.base, board), SIMULATIONS),
        );

        // Ценность считается ровно так же, как её считал советник: при
        // покупке через продажу — против борда БЕЗ жертвы (см. buyRules).
        const against =
          buy.sellFirst === null
            ? state
            : {
                ...state,
                board: state.board.filter((m) => m.entityId !== buy.sellFirst?.entityId),
              };
        const value = minionValue(buy.minion, against, { cards }, DEFAULT_TAVERN_RULES);
        const stat = stats.stat(buy.minion.cardId);

        appendFileSync(
          outPath,
          JSON.stringify({
            fixture,
            turn: decision.turn,
            candIndex: index,
            cardId: buy.minion.cardId,
            name: cards.info(buy.minion.cardId)?.name ?? buy.minion.cardId,
            techLevel: buy.minion.techLevel ?? cards.info(buy.minion.cardId)?.techLevel ?? null,
            golden: buy.minion.golden,
            cost: buy.cost,
            sellFirst: buy.sellFirst?.entityId ?? null,
            isHeuristicPick: index === 0,
            // Сверка: total из дампа обязан совпасть с очками совета.
            score: buy.score,
            v: {
              techLevel: value.techLevel,
              stats: value.stats,
              tribe: value.tribe,
              keywords: value.keywords,
              copies: value.copies,
              golden: value.golden,
              economy: value.economy,
              battle: value.battle,
              textTribe: value.textTribe,
              textMech: value.textMech,
              namedCard: value.namedCard,
              total: value.total,
            },
            outcome: result.wonPercent + result.tiedPercent / 2,
            sims: SIMULATIONS,
            opponentBoardSize: decision.opponentBoard.length,
            shopSize: state.shop.length,
            stat:
              stat === null
                ? null
                : {
                    placement: stat.averagePlacement,
                    other: stat.averagePlacementOther,
                    impact: stat.impact,
                    residual: stat.residual,
                    totalPlayed: stat.totalPlayed,
                  },
            statGain: statGainOf(stat, CAP_PLACES),
          }) + '\n',
          'utf8',
        );
        rows += 1;
      });
    }
    console.log(
      `${fixture}: ходов ${String(enumeration.decisions.length)}, строк всего ${String(rows)}, ` +
        `${String(Math.round((Date.now() - started) / 1000))} с`,
    );
  }

  console.log(
    `\nдамп: ${outPath}\nходов ${String(turns)}, кандидатов ${String(rows)}, ` +
      `пропущено без боя ${String(skippedNoBattle)}, без выбора ${String(skippedNoChoice)}, ` +
      `${String(Math.round((Date.now() - started) / 1000))} с`,
  );
}

main();
