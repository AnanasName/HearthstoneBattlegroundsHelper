import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import type { GameState } from '../../state/types.js';
import { resolveOpponent, type ResolvedOpponent } from './opponent.js';
import { withSeededRandom } from './rng.js';
import { distinguishable, objectiveOf, toEstimate, winRate } from './score.js';
import {
  DEFAULT_SEARCH_OPTIONS,
  searchArrangement,
  type Candidate,
  type SearchOptions,
  type SearchReport,
} from './search.js';

/**
 * PositionAdvisor: какую расстановку своего борда играть.
 *
 * Здесь сходятся три части — симулятор боя из фазы 2, поиск по перестановкам
 * и правило «против кого считать». Сам поиск про симулятор ничего не знает,
 * поэтому вся обвязка живёт тут.
 */

export interface PositionAdvice {
  /** Лучшие расстановки по убыванию; первая — рекомендация. */
  readonly top: readonly Candidate[];
  /** Текущая расстановка, посчитанная с той же точностью, что и финалисты. */
  readonly current: Candidate;
  /**
   * Стоит ли вообще переставлять.
   *
   * `false` не значит «перестановка не поможет» — значит «на наших числах
   * улучшение неотличимо от шума». Советовать перестановку ради разницы
   * внутри стандартной ошибки хуже, чем молчать: игрок потратит время хода
   * на действие, которое ничего не меняет.
   */
  readonly improves: boolean;
  /**
   * Насколько лучше рекомендация по той величине, которой шло сравнение, в п.п.
   *
   * Для цели по умолчанию это победа плюс половина ничьей: бывают бои, где
   * доля побед у всех расстановок нулевая, а решается всё тем, свести ли
   * бой вничью, — и разницу надо показывать именно там, где она есть.
   */
  readonly gain: number;
  /** Насколько выше именно доля побед, в п.п. Для подписи в интерфейсе. */
  readonly winGain: number;
  readonly report: SearchReport;
  readonly elapsedMs: number;
}

/**
 * Счёт брошен, потому что состояние успело измениться.
 *
 * Отдельный класс, а не флаг в ответе: прерванный поиск ответа не имеет,
 * и отличать его от «посчитали и ничего не нашли» обязан сам тип.
 */
export class SearchAborted extends Error {
  constructor() {
    super('поиск расстановки прерван');
    this.name = 'SearchAborted';
  }
}

export interface PositionAdvisorDeps {
  readonly simulator: BattleSimulator;
  /**
   * Пора ли бросить счёт. Спрашивается перед оценкой каждого кандидата.
   *
   * Живому режиму это необходимо: совет считается секунды, а игрок за это
   * время успевает купить миньона, и досчитанный ответ относится уже
   * к несуществующему борду. Прерывание кооперативное — поиск синхронный,
   * извне его не остановить.
   */
  readonly aborted?: () => boolean;
}

/**
 * Совет по расстановке для конкретного боя.
 *
 * `setup` — уже собранное положение дел: свой борд, борд противника, герой,
 * ход. Откуда взялся борд противника — из текущего боя или из последнего
 * увиденного — здесь неважно, это решает `resolveOpponent`.
 */
export function advisePosition(
  setup: BattleSetup,
  { simulator, aborted }: PositionAdvisorDeps,
  overrides: Partial<SearchOptions> = {},
): PositionAdvice {
  const started = Date.now();
  // Число симуляций в базовом входе не используется: поиск задаёт своё
  // на каждый вызов.
  const base = toBattleInfo(setup, 1);

  const report = searchArrangement(
    setup.playerBoard,
    (board, sims, seed) => {
      // Проверка перед оценкой, а не внутри неё: одна оценка — это от 27
      // до 150 мс, и такой задержки прерыванию довольно.
      if (aborted?.() === true) throw new SearchAborted();

      // Зерно фиксируется не ради точности — замер показал, что общие
      // случайные числа разброс не уменьшают, — а ради воспроизводимости.
      // Оговорка тут существенная: воспроизводимость полная, только пока
      // поиск не режется бюджетом в миллисекундах. С включённым бюджетом
      // число просмотренных кандидатов зависит от загрузки машины, и совет
      // может отличаться. Чтобы разобрать конкретный случай до последней
      // симуляции, бюджет надо снять — тогда вход определяет ответ целиком.
      return toEstimate(
        withSeededRandom(seed, () => simulator.run(withPlayerBoard(base, board), sims)),
      );
    },
    overrides,
  );

  const objective = overrides.objective ?? DEFAULT_SEARCH_OPTIONS.objective;
  const best = report.top[0];

  return {
    top: report.top,
    current: report.current,
    improves:
      best !== undefined &&
      best.key !== report.current.key &&
      best.score > report.current.score &&
      distinguishable(best.estimate, report.current.estimate, objective),
    gain:
      best === undefined
        ? 0
        : (objectiveOf(best.estimate, objective) -
            objectiveOf(report.current.estimate, objective)) *
          100,
    winGain:
      best === undefined ? 0 : (winRate(best.estimate) - winRate(report.current.estimate)) * 100,
    report,
    elapsedMs: Date.now() - started,
  };
}

export interface StateAdvice extends PositionAdvice {
  readonly opponent: ResolvedOpponent;
}

export interface PositionQuestion {
  readonly setup: BattleSetup;
  readonly opponent: ResolvedOpponent;
}

/**
 * Кого против кого считать — или `null`, если считать нечего.
 *
 * Вынесено отдельно, потому что спрашивают из двух мест: пакетный
 * `advisePositionForState` считает тут же, а живой режим отправляет тот же
 * `setup` в воркер. Собирать его дважды — верный способ разойтись.
 */
export function positionQuestion(state: GameState): PositionQuestion | null {
  const opponent = resolveOpponent(state);
  if (!opponent.usable || state.hero === null || state.board.length === 0) return null;

  return {
    opponent,
    setup: {
      turn: state.turn,
      playerBoard: state.board,
      opponentBoard: opponent.board,
      playerHero: state.hero,
      techLevel: state.techLevel,
      anomalyCardId: state.anomalyCardId,
      globalInfo: state.globalInfo,
    },
  };
}

/**
 * Совет по расстановке прямо из состояния партии.
 *
 * Возвращает `null`, когда считать нечего или не против кого: пустой борд,
 * конец партии, неизвестный противник. Молчание тут честнее выдуманного
 * противника — расстановка против несуществующего борда не лучше случайной.
 */
export function advisePositionForState(
  state: GameState,
  deps: PositionAdvisorDeps,
  overrides: Partial<SearchOptions> = {},
): StateAdvice | null {
  const question = positionQuestion(state);
  if (question === null) return null;

  return { ...advisePosition(question.setup, deps, overrides), opponent: question.opponent };
}
