import { readBattleEpisodes } from '../battle/episodes.js';
import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import type { CardIndex } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import { adviseTavern, type Recommendation } from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';
import { readTavernTurns } from './turns.js';

/**
 * Насколько эвристика покупок совпадает с тем, что покупка даёт в бою.
 *
 * Эвристику нечем проверить изнутри: веса подобраны руками, и тест на них
 * проверяет лишь то, что код считает как задумано, а не то, что задумано
 * верно. Внешняя мерка — симулятор боя из фазы 2.
 *
 * ## Против кого считать — первый ответ был неверным
 *
 * Брать «последний увиденный борд следующего противника», как это делает
 * живой советник, здесь нельзя: в фикстурах он устаревал на 7–17 ходов,
 * все шесть сравнений выходили разгромом 100:0, а разброс между кандидатами
 * оказывался тождественным нулём. Проверка, в которой верен любой ответ,
 * не проверка.
 *
 * Поэтому берётся борд, который у противника ФАКТИЧЕСКИ оказался в бою
 * следующего хода. Это знание, недоступное игроку в момент решения, и живому
 * советнику оно не годится. Но вопрос здесь другой: не «что мог знать игрок»,
 * а «связана ли наша шкала ценности с реальной пользой в бою».
 *
 * ## Что остаётся за скобками
 *
 *  - считается только ближайший бой, а покупка делается и на три хода вперёд;
 *  - купленный миньон ставится в конец борда, без поиска расстановки: иначе
 *    сравнение мерило бы советник расстановки. Политика одна для всех
 *    кандидатов, поэтому на их порядок это влияет слабо.
 */

export interface BuyComparison {
  readonly turn: number;
  /** Сколько покупок было доступно. */
  readonly candidates: number;
  readonly heuristicPick: Recommendation;
  readonly simulatorPick: Recommendation;
  /** Ожидаемый исход при совете эвристики: победа плюс половина ничьей. */
  readonly heuristicOutcome: number;
  /** Он же у лучшего по симулятору. */
  readonly bestOutcome: number;
  /** Разброс исходов между кандидатами: ноль означает, что выбор не решал. */
  readonly spread: number;
  /** Совпало ли решение. Сравнение по карте: две копии одной — один выбор. */
  readonly agreed: boolean;
  readonly opponentBoardSize: number;
}

export interface BuyQualityReport {
  readonly rows: readonly BuyComparison[];
  /** Ходы, где разброс исходов больше порога, — только там выбор что-то значил. */
  readonly decisive: readonly BuyComparison[];
  readonly skippedNoBattle: number;
  readonly skippedNoChoice: number;
}

export interface BuyQualityOptions {
  readonly simulations: number;
  /** Ниже этого разброса исходов ход считается не решающим ничего, в п.п. */
  readonly decisiveSpread: number;
  readonly rules: TavernRules;
}

export const DEFAULT_BUY_QUALITY_OPTIONS: BuyQualityOptions = {
  simulations: 2000,
  // Порог «выбор что-то решал» обязан превышать шум Монте-Карло, иначе
  // «решающие» ходы набираются из дрожания оценок: при 2000 симуляций
  // стандартная ошибка разности двух долей около 1.6 п.п., и прежний порог
  // в 1 п.п. сидел ниже неё. Проверено на числах: при 800 симуляций тот же
  // замер давал 33% совпадений на «решающих» ходах, при 2000 — 62%, то есть
  // сам состав множества зависел от шума.
  decisiveSpread: 3,
  rules: DEFAULT_TAVERN_RULES,
};

/** Ожидаемый исход боя одним числом: победа плюс половина ничьей. */
const outcomeScore = (won: number, tied: number): number => won + tied / 2;

export function measureBuyQuality(
  text: string,
  deps: { readonly cards: CardIndex; readonly simulator: BattleSimulator },
  overrides: Partial<BuyQualityOptions> = {},
): BuyQualityReport {
  const options = { ...DEFAULT_BUY_QUALITY_OPTIONS, ...overrides };

  // Счётчик хода растёт на переходе в бой: таверна идёт нечётными номерами,
  // бой следом — чётным. Проверено на обеих фикстурах.
  const actualOpponents = new Map(readBattleEpisodes(text).map((e) => [e.turn, e.opponentBoard]));

  const rows: BuyComparison[] = [];
  let skippedNoBattle = 0;
  let skippedNoChoice = 0;

  for (const { state } of readTavernTurns(text)) {
    const advice = adviseTavern(state, deps, options.rules);
    if (advice === null || state.hero === null) continue;

    const buys = advice.recommendations.filter(
      (r): r is Recommendation & { minion: Minion } => r.action === 'buy' && r.minion !== null,
    );
    if (buys.length < 2) {
      skippedNoChoice += 1;
      continue;
    }

    const opponentBoard = actualOpponents.get(state.turn + 1);
    if (opponentBoard === undefined || opponentBoard.length === 0) {
      skippedNoBattle += 1;
      continue;
    }

    const setup: BattleSetup = {
      turn: state.turn,
      playerBoard: state.board,
      opponentBoard,
      playerHero: state.hero,
      techLevel: state.techLevel,
      anomalyCardId: state.anomalyCardId,
      globalInfo: state.globalInfo,
      playerTrinketDbfIds:
        state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
      opponentTrinketDbfIds:
        state.nextOpponentPlayerId === null
          ? []
          : (state.trinketsByPlayer[state.nextOpponentPlayerId] ?? []),
    };
    const base = toBattleInfo(setup, 1);

    const measured = buys.map((buy) => {
      // Продавать приходится, только если места нет.
      const after = [
        ...state.board.filter((m) => buy.sellFirst === null || m.entityId !== buy.sellFirst.entityId),
        buy.minion,
      ];
      const result = simulate(deps.simulator, base, after, options.simulations);
      return { buy, outcome: outcomeScore(result.won, result.tied) };
    });

    const heuristic = measured[0];
    if (heuristic === undefined) continue;
    const best = measured.reduce((a, b) => (b.outcome > a.outcome ? b : a));
    const outcomes = measured.map((m) => m.outcome);

    rows.push({
      turn: state.turn,
      candidates: measured.length,
      heuristicPick: heuristic.buy,
      simulatorPick: best.buy,
      heuristicOutcome: heuristic.outcome,
      bestOutcome: best.outcome,
      spread: Math.max(...outcomes) - Math.min(...outcomes),
      // По карте, а не по сущности: в витрине бывают две копии одного
      // миньона, и купить любую из них — одно и то же решение.
      agreed: heuristic.buy.minion.cardId === best.buy.minion.cardId,
      opponentBoardSize: opponentBoard.length,
    });
  }

  return {
    rows,
    decisive: rows.filter((r) => r.spread > options.decisiveSpread),
    skippedNoBattle,
    skippedNoChoice,
  };
}

function simulate(
  simulator: BattleSimulator,
  base: ReturnType<typeof toBattleInfo>,
  board: readonly Minion[],
  simulations: number,
): { won: number; tied: number } {
  const result = simulator.run(withPlayerBoard(base, board), simulations);
  return { won: result.wonPercent, tied: result.tiedPercent };
}

/** Доля совпадений с симулятором. */
export function agreementRate(rows: readonly BuyComparison[]): number {
  if (rows.length === 0) return 0;
  return rows.filter((r) => r.agreed).length / rows.length;
}

/** Средняя цена расхождения в пунктах ожидаемого исхода. */
export function averageCost(rows: readonly BuyComparison[]): number {
  if (rows.length === 0) return 0;
  return rows.reduce((sum, r) => sum + (r.bestOutcome - r.heuristicOutcome), 0) / rows.length;
}
