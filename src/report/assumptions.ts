import { toBattleInfo, type BattleSetup } from '../advisors/battle/mapper.js';
import { withSeededRandom } from '../advisors/position/rng.js';
import { EMPTY_ESTIMATE, distinguishable, mergeEstimates, toEstimate, type Estimate } from '../advisors/position/score.js';
import { boardsOfTurn } from '../advisors/strength/boards.js';
import { spendPlan } from '../advisors/tavern/spend.js';
import type { CardIndex } from '../data/cards.js';
import { playersAlive, type GameState, type Minion } from '../state/types.js';
import { numbersOf, type RecountDeps } from './battle.js';
import type { BattleRecount, Finding } from './types.js';
import type { ReportTurn } from './timeline.js';
import { boards } from './words.js';

/**
 * Предположение «план советника против хода игрока» — по ближайшему бою
 * против поля хода.
 *
 * Это НЕ суд над игроком, и в отчёте оно стоит в разделе предположений.
 * Советник вне выборки игрока не опережает (deferred.md, «Ход игрока
 * против хода советника»: −0.53 п.п. при МРЭ 2.33), а в ручных разборах
 * журнала расхождения чаще оказывались правотой игрока (part53: восемь
 * из одиннадцати). Поэтому пункт печатается в обе стороны — и когда
 * сильнее план, и когда сильнее ход игрока, — числами, без вердикта
 * (D193).
 *
 * ## Мера — та же, что в ручных разборах и `spike:plandiff`
 *
 * Итоговый борд игрока (снимок перед `MAIN_END`: триггеров конца хода
 * нет ни у него, ни у плана) против итогового борда плана — против поля
 * бордов того же хода таверны, без бордов своей партии, одни зёрна
 * на обе стороны. Абсолютные проценты борда конца таверны калибровкой
 * силы стола не покрыты (она снята на борде боя, `strength/spike.ts`),
 * поэтому смысл имеет только РАЗНИЦА двух чисел.
 *
 * ## Когда молчит
 *
 * - план оборван непрозрачным шагом (обновление, сила, заклинание):
 *   итогового борда у плана нет;
 * - в поле хода меньше 12 бордов — число без выборки;
 * - разница не выше шума (2σ) или меньше 5 п.п.
 */

export interface PlanOptions {
  readonly simsPerBoard: number;
  readonly minBoards: number;
  /** Меньше этой разницы, п.п., пункт не печатается даже различимым. */
  readonly minGapPp: number;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  simsPerBoard: 100,
  minBoards: 12,
  minGapPp: 5,
};

const PLAN_SEED = 20260929;

export type PlanJudgement =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'same' }
  | { readonly kind: 'quiet'; readonly recount: BattleRecount }
  | {
      readonly kind: 'shown';
      readonly recount: BattleRecount;
      readonly planBoard: readonly Minion[];
      readonly planSteps: readonly string[];
    };

/** Состав стола без порядка — совпал ли итог хода с итогом плана. */
function boardKey(board: readonly Minion[]): string {
  return board
    .map((m) => `${m.cardId}:${String(m.attack ?? 0)}/${String(m.health ?? 0)}`)
    .sort()
    .join(',');
}

function fieldSetups(state: GameState, deps: RecountDeps, tavernTurn: number): BattleSetup[] {
  if (deps.field === null || state.hero === null) return [];
  const hero = state.hero;
  const alive = playersAlive(state);
  return boardsOfTurn(deps.field, tavernTurn, deps.excludePart).map((b) => ({
    turn: state.turn,
    playerBoard: state.board,
    playerHand: state.hand,
    opponentBoard: b.board,
    playerHero: hero,
    techLevel: state.techLevel,
    anomalyCardId: state.anomalyCardId,
    globalInfo: state.globalInfo,
    playerDeity: state.deity,
    playerTrinketDbfIds:
      state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
    opponentTrinketDbfIds: b.trinketDbfIds,
    playersAlive: alive,
  }));
}

function onField(setups: readonly BattleSetup[], deps: RecountDeps, sims: number): Estimate {
  let merged = EMPTY_ESTIMATE;
  setups.forEach((setup, i) => {
    const input = toBattleInfo(setup, sims);
    merged = mergeEstimates(
      merged,
      toEstimate(withSeededRandom(PLAN_SEED * 31 + i, () => deps.simulator.run(input, sims))),
    );
  });
  return merged;
}

export function judgePlan(
  start: GameState,
  turn: ReportTurn,
  cards: CardIndex,
  deps: RecountDeps,
  describe: (steps: ReturnType<typeof spendPlan>['steps']) => readonly string[],
  options: PlanOptions = DEFAULT_PLAN_OPTIONS,
): PlanJudgement {
  const plan = spendPlan(start, { cards });
  const last = plan.steps.at(-1);
  if (last === undefined) return { kind: 'skip', reason: 'советник молчал' };
  if (plan.truncated || plan.steps.some((s) => s.opaque)) {
    return { kind: 'skip', reason: 'план с обновлением, силой или заклинанием — итогового борда у него нет' };
  }
  // Магнит в итоговом борде плана статов носителю не отдаёт — сравнение
  // вышло бы в пользу игрока (ревью: part74, ход таверны 6).
  if (plan.steps.some((s) => s.recommendation.minion !== null && cards.info(s.recommendation.minion.cardId)?.magnetic === true)) {
    return { kind: 'skip', reason: 'в плане магнит — статы носителя итоговый борд плана не несёт' };
  }
  const planState = last.stateAfter;
  const player = turn.end;
  // Подъём у любой стороны — размен статов на темп, а темп ближайший бой
  // не видит по устройству (D193): сравнение вышло бы систематически
  // против того, кто поднимался.
  if (planState.techLevel > start.techLevel || player.techLevel > start.techLevel) {
    return { kind: 'skip', reason: 'в ходу подъём таверны — темп ближайший бой не видит (D193)' };
  }
  if (boardKey(planState.board) === boardKey(player.board)) return { kind: 'same' };
  if (player.board.length === 0 || planState.board.length === 0) {
    return { kind: 'skip', reason: 'пустой борд — сравнивать нечего' };
  }

  const playerSetups = fieldSetups(player, deps, turn.tavernTurn);
  if (playerSetups.length < options.minBoards) {
    return { kind: 'skip', reason: `в поле хода меньше ${String(options.minBoards)} бордов` };
  }
  const planSetups = fieldSetups(planState, deps, turn.tavernTurn);
  const played = onField(playerSetups, deps, options.simsPerBoard);
  const alt = onField(planSetups, deps, options.simsPerBoard);
  const recount: BattleRecount = {
    against: `против поля хода (${boards(playerSetups.length)})`,
    played: numbersOf(played),
    alternative: numbersOf(alt),
    distinguishable: distinguishable(alt, played, 'winRate'),
    singleOpponent: false,
  };
  const gap = Math.abs(recount.alternative.scorePct - recount.played.scorePct);
  if (!recount.distinguishable || gap < options.minGapPp) return { kind: 'quiet', recount };

  return {
    kind: 'shown',
    recount,
    planBoard: planState.board,
    planSteps: describe(plan.steps),
  };
}

/** Пункт отчёта из предположения о плане. */
export function planFinding(
  turn: ReportTurn,
  judgement: Extract<PlanJudgement, { kind: 'shown' }>,
  boardLine: (board: readonly Minion[]) => string,
): Finding {
  const { recount } = judgement;
  const planStronger = recount.alternative.scorePct > recount.played.scorePct;
  const caveats = [
    'Ближайший бой не видит экономики, карт в руке и копящих тел (D166): это число о следующем бое, а не о партии.',
    'План посчитан текущей версией советника — не обязательно тем, что оверлей показывал в игре: показанное не записывается.',
  ];
  return {
    kind: 'assumption',
    klass: 'planVsPlayer',
    turn: turn.turn,
    tavernTurn: turn.tavernTurn,
    time: turn.endTime.slice(0, 8),
    title: planStronger
      ? `План советника давал стол сильнее вашего: ${recount.alternative.scorePct.toFixed(0)} % против ${recount.played.scorePct.toFixed(0)} % побед по полю`
      : `Ваш стол сильнее плана советника: ${recount.played.scorePct.toFixed(0)} % против ${recount.alternative.scorePct.toFixed(0)} % побед по полю`,
    details: [
      `план: ${judgement.planSteps.join(' → ')}`,
      `стол плана: ${boardLine(judgement.planBoard)}`,
      `ваш стол: ${boardLine(turn.end.board)}`,
    ],
    impact: recount,
    impactNote: null,
    nextBattle: null,
    caveats,
  };
}
