import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import type { GameState, Minion } from '../../state/types.js';
import { resolveTarget, type PositionTarget } from './opponent.js';
import { withSeededRandom } from './rng.js';
import {
  EMPTY_ESTIMATE,
  distinguishable,
  mergeEstimates,
  objectiveOf,
  toEstimate,
  winRate,
} from './score.js';
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

/** Раздача симуляций по бордам поля: поровну, остаток первым. */
function splitSims(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Совет по расстановке для боя — или для поля возможных боёв.
 *
 * `setups` — уже собранные положения дел, по одному на борд противника.
 * Один сетап — обычный счёт против известного противника. Несколько —
 * счёт против поля: симуляции каждого кандидата делятся между бордами
 * поровну, счётчики складываются, и оценка становится средним исходом
 * по полю. Больше в поиске не меняется ничего: накопление, финальные
 * раунды и значимость работают на слитых счётчиках так же, как на одном
 * борде. Свой борд у всех сетапов обязан быть одним и тем же — иначе
 * кандидаты сравниваются в разных условиях.
 *
 * Откуда борды взялись — текущий бой, последний увиденный или всё поле —
 * здесь неважно, это решает `resolveTarget`.
 */
export function advisePosition(
  setups: BattleSetup | readonly BattleSetup[],
  { simulator, aborted }: PositionAdvisorDeps,
  overrides: Partial<SearchOptions> = {},
): PositionAdvice {
  const list: readonly BattleSetup[] = Array.isArray(setups)
    ? (setups as readonly BattleSetup[])
    : [setups as BattleSetup];
  const first = list[0];
  if (first === undefined) throw new Error('нет ни одного борда противника');
  if (list.some((s) => s.playerBoard !== first.playerBoard)) {
    throw new Error('сетапы поля обязаны разделять один и тот же свой борд');
  }

  const started = Date.now();
  // Число симуляций в базовом входе не используется: поиск задаёт своё
  // на каждый вызов.
  const bases = list.map((setup) => toBattleInfo(setup, 1));

  const evaluate = (board: readonly Minion[], sims: number, seed: number) => {
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
    const single = bases[0];
    if (bases.length === 1 && single !== undefined) {
      return toEstimate(
        withSeededRandom(seed, () => simulator.run(withPlayerBoard(single, board), sims)),
      );
    }

    // Поле: делёж поровну — это послойная выборка среднего по бордам, она
    // точнее случайного выбора борда на каждую симуляцию. Зерно у каждого
    // борда своё, но выводится из общего: шаг 31 больше любого мыслимого
    // поля, поэтому зёрна разных вызовов не пересекаются.
    const parts = splitSims(sims, bases.length);
    let merged = EMPTY_ESTIMATE;
    for (const [i, base] of bases.entries()) {
      const n = parts[i];
      if (n === undefined || n <= 0) continue;
      merged = mergeEstimates(
        merged,
        toEstimate(
          withSeededRandom(seed * 31 + i, () => simulator.run(withPlayerBoard(base, board), n)),
        ),
      );
    }
    return merged;
  };

  const report = searchArrangement(first.playerBoard, evaluate, overrides);

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
  readonly target: PositionTarget;
}

export interface PositionQuestion {
  /** По сетапу на борд противника; поле даёт их несколько. */
  readonly setups: readonly BattleSetup[];
  readonly target: PositionTarget;
}

/**
 * Против чего считать — или `null`, если считать нечего.
 *
 * Вынесено отдельно, потому что спрашивают из двух мест: пакетный
 * `advisePositionForState` считает тут же, а живой режим отправляет те же
 * `setups` в воркер. Собирать их дважды — верный способ разойтись.
 */
export function positionQuestion(state: GameState): PositionQuestion | null {
  const target = resolveTarget(state);
  if (target === null || state.hero === null || state.board.length === 0) return null;
  const hero = state.hero;

  const setupAgainst = (
    opponentBoard: readonly Minion[],
    opponentPlayerId: number | null,
  ): BattleSetup => ({
    turn: state.turn,
    playerBoard: state.board,
    opponentBoard,
    playerHero: hero,
    techLevel: state.techLevel,
    anomalyCardId: state.anomalyCardId,
    globalInfo: state.globalInfo,
    playerTrinketDbfIds:
      state.playerId === null ? [] : (state.trinketsByPlayer[state.playerId] ?? []),
    opponentTrinketDbfIds:
      opponentPlayerId === null ? [] : (state.trinketsByPlayer[opponentPlayerId] ?? []),
  });

  return {
    target,
    setups:
      target.kind === 'single'
        ? [setupAgainst(target.opponent.board, target.opponent.playerId)]
        : target.boards.map((seen) => setupAgainst(seen.board, seen.playerId)),
  };
}

/**
 * Совет по расстановке прямо из состояния партии.
 *
 * Возвращает `null`, когда считать не на чем: пустой борд, конец партии,
 * ни одного виденного борда. Молчание тут честнее выдуманного противника —
 * расстановка против несуществующего борда не лучше случайной.
 */
export function advisePositionForState(
  state: GameState,
  deps: PositionAdvisorDeps,
  overrides: Partial<SearchOptions> = {},
): StateAdvice | null {
  const question = positionQuestion(state);
  if (question === null) return null;

  return { ...advisePosition(question.setups, deps, overrides), target: question.target };
}
