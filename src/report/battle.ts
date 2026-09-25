import { endOfTurnAuraGains } from '../advisors/battle/endOfTurn.js';
import type { BattleEpisode } from '../advisors/battle/episodes.js';
import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../advisors/battle/mapper.js';
import type { BattleSimulator } from '../advisors/battle/simulator.js';
import { advisePosition } from '../advisors/position/advisor.js';
import { paidSlots } from '../advisors/position/paidSlot.js';
import { withSeededRandom } from '../advisors/position/rng.js';
import {
  EMPTY_ESTIMATE,
  distinguishable,
  mergeEstimates,
  objectiveOf,
  toEstimate,
  type Estimate,
} from '../advisors/position/score.js';
import { boardsOfTurn, type FieldSnapshot } from '../advisors/strength/boards.js';
import { sameGameBuild } from '../data/builds.js';
import type { CardIndex } from '../data/cards.js';
import type { GameState, Minion } from '../state/types.js';
import { BOARD_LIMIT } from './facts.js';
import type { BattleNumbers, BattleRecount } from './types.js';
import { boards as boardsWord } from './words.js';

/**
 * Пересчёт боя для отчёта: «чего стоило» и «была ли расстановка хуже».
 *
 * ## Против кого — зависит от вопроса
 *
 * «Ошибся ли» решается только тем, что игрок мог знать в таверне, —
 * против ПОЛЯ бордов того же хода: борда своего соперника он не видел,
 * и расстановка, лучшая против него, против поля бывает хуже сыгранной
 * (разведка 25.09, part52–55: так в 10 боях из 16). «Чего стоило»
 * спрашивается задним числом, и там честен фактический соперник:
 * бой уже случился. Исход боя в ворота факта не входит — иначе одна
 * и та же расстановка была бы ошибкой при поражении и не была бы при
 * победе (критик спецификации, 25.09).
 *
 * ## Борд — конца таверны, не эпизода
 *
 * Эпизод снят после Start of Combat, и симулятор применил бы эти эффекты
 * второй раз — ложные «ошибки» до +62 п.п. (part33, Al'Akir). Основной
 * счёт — по снимку перед `TURN=N+1` (`ReportTurn.beforeCombat`). Борд
 * эпизода — только проверка устойчивости: на 40 боях part33, 52–56
 * вывод «различимо лучше» менялся от источника борда в 7 случаях, и факт
 * обязан держаться на обоих.
 *
 * ## Лучшая переоценивается на свежих зёрнах
 *
 * Максимум из многих шумных оценок смещён вверх (D185): выигрыш лучшей
 * расстановки, судимый по той же выборке, на которой её выбрали, завышен
 * примерно вдвое. Отбор идёт на одних зёрнах, числа отчёта — на других.
 * Множественность проверок по шуму не страшна (≈ 0.007 ложного факта
 * на партию при двух тестах по 2σ), опасна систематика модели — от неё
 * устойчивость, поле своего билда и молчание при баффах конца хода.
 */

export interface RecountDeps {
  readonly simulator: BattleSimulator;
  readonly cards: CardIndex;
  /** Поле бордов хода — для проверки «лучше при любом сопернике». */
  readonly field: FieldSnapshot | null;
  /** Партия-фикстура, которую нельзя мерить об её же борды (`boardsOfTurn`). */
  readonly excludePart: number | null;
  /** Билд разбираемой партии: поле чужого билда факта не даёт. */
  readonly gameBuild: number | null;
}

export interface RecountOptions {
  /** Симуляций на вариант при проверке против фактического соперника. */
  readonly verifySims: number;
  /** Симуляций на вариант при выборе лучшего (свои зёрна). */
  readonly pickSims: number;
  /** Симуляций на один борд поля. */
  readonly fieldSimsPerBoard: number;
  /** Меньше скольких бордов поле хода не считается (как у силы стола). */
  readonly minFieldBoards: number;
  /** Порог «исход не выброс» (DoD фазы 2): доля фактического исхода, %. */
  readonly outlierPct: number;
  /** Факт расстановки: насколько лучшая лучше против поля, п.п. Объявлен до прогона. */
  readonly factFieldGapPp: number;
  /** Предположение: насколько лучшая лучше против соперника, п.п. */
  readonly guessGapPp: number;
}

export const DEFAULT_RECOUNT_OPTIONS: RecountOptions = {
  // 4000 симуляций — ошибка разности двух долей около 1.1 п.п. при p≈0.5,
  // как у независимой проверки советника в test/advisors/position.
  verifySims: 4000,
  pickSims: 2000,
  fieldSimsPerBoard: 100,
  minFieldBoards: 12,
  outlierPct: 5,
  factFieldGapPp: 2,
  guessGapPp: 5,
};

/**
 * Билд, на котором собрано поле бордов, если снапшот его не называет:
 * поле 19.09 собрано из part4–55 (`CURRENT_BUILD_PARTS`), последний
 * их билд — 251952. Снапшот, пересобранный после этого, обязан нести
 * `build` сам (next-steps).
 */
export const FIELD_BUILD_FALLBACK = 251952;

/** Зёрна отбора и проверки разведены, чтобы проверка не видела отбора. */
const PICK_SEED = 20260925;
const VERIFY_SEED_PLAYED = 20260926;
const VERIFY_SEED_ALT = 20260927;
const FIELD_SEED = 20260928;

/** Поиск расстановки без бюджета по часам: вход определяет ответ целиком. */
const NO_BUDGET = { screenBudgetMs: 3_600_000, budgetMs: 3_600_000 };

export function numbersOf(e: Estimate): BattleNumbers {
  const rate = (n: number): number => (e.sims === 0 ? 0 : (n / e.sims) * 100);
  return {
    scorePct: objectiveOf(e, 'winRate') * 100,
    winPct: rate(e.won),
    tiePct: rate(e.tied),
    lossPct: rate(e.lost),
    expectedDamage: e.sims === 0 ? 0 : e.damageLost / e.sims,
    sims: e.sims,
  };
}

/** Билд поля: из снапшота, если он его знает. */
export function fieldBuild(field: FieldSnapshot | null): number | null {
  if (field === null) return null;
  return (field as FieldSnapshot & { readonly build?: number }).build ?? FIELD_BUILD_FALLBACK;
}

/** Поле собрано на той же игре, что разбираемая партия. */
export function fieldFitsGame(deps: Pick<RecountDeps, 'field' | 'gameBuild'>): boolean {
  return sameGameBuild(fieldBuild(deps.field), deps.gameBuild);
}

/** Бой после хода: соперник и исход из эпизода, свой стол — конца таверны. */
export function nextBattleSetup(episode: BattleEpisode, beforeCombat: GameState): BattleSetup {
  return { ...episode, playerBoard: beforeCombat.board, playerHand: beforeCombat.hand };
}

function run(
  simulator: BattleSimulator,
  setup: BattleSetup,
  board: readonly Minion[],
  hand: readonly Minion[] | undefined,
  sims: number,
  seed: number,
): Estimate {
  const input = withPlayerBoard(toBattleInfo({ ...setup, playerHand: hand }, sims), board);
  return toEstimate(withSeededRandom(seed, () => simulator.run(input, sims)));
}

const AGAINST_OPPONENT = 'против фактического соперника';

function recountOf(against: string, played: Estimate, alternative: Estimate, singleOpponent: boolean): BattleRecount {
  return {
    against,
    played: numbersOf(played),
    alternative: numbersOf(alternative),
    distinguishable: distinguishable(alternative, played, 'winRate'),
    singleOpponent,
  };
}

/** Доля фактического исхода среди симуляций сыгранного, %. */
function actualOutcomePct(e: Estimate, outcome: BattleEpisode['outcome']): number {
  if (e.sims === 0) return 0;
  const n = outcome === 'won' ? e.won : outcome === 'lost' ? e.lost : e.tied;
  return (n / e.sims) * 100;
}

/**
 * Сыгранный стол против каждого миньона-кандидата, поставленного в хвост
 * борда: лучший выбирается на своих зёрнах, числа — на свежих.
 *
 * Для сгоревшего золота: «если бы купил хоть что-то из витрины». Клич
 * покупки в пересчёт не входит — кандидат ставится голым телом, так же,
 * как в арене выбирающих (`chooserArena.ts`).
 */
export function recountAddition(
  setup: BattleSetup,
  candidates: readonly Minion[],
  deps: RecountDeps,
  options: RecountOptions = DEFAULT_RECOUNT_OPTIONS,
): { readonly minion: Minion; readonly recount: BattleRecount } | null {
  const board = setup.playerBoard;
  if (board.length >= BOARD_LIMIT || candidates.length === 0) return null;
  const hand = setup.playerHand;
  let best: { minion: Minion; score: number } | null = null;
  const seen = new Set<string>();
  for (const minion of candidates) {
    if (seen.has(minion.cardId)) continue;
    seen.add(minion.cardId);
    const e = run(deps.simulator, setup, [...board, minion], hand, options.pickSims, PICK_SEED);
    const score = objectiveOf(e, 'winRate');
    if (best === null || score > best.score) best = { minion, score };
  }
  if (best === null) return null;
  const played = run(deps.simulator, setup, board, hand, options.verifySims, VERIFY_SEED_PLAYED);
  const alt = run(deps.simulator, setup, [...board, best.minion], hand, options.verifySims, VERIFY_SEED_ALT);
  return { minion: best.minion, recount: recountOf(AGAINST_OPPONENT, played, alt, true) };
}

/** Миньон из руки — на борд, в хвост: «если бы успел поставить». */
export function recountPlacement(
  setup: BattleSetup,
  minion: Minion,
  deps: RecountDeps,
  options: RecountOptions = DEFAULT_RECOUNT_OPTIONS,
): BattleRecount | null {
  const board = setup.playerBoard;
  if (board.length >= BOARD_LIMIT) return null;
  const hand = setup.playerHand;
  const handAfter = hand?.filter((m) => m.entityId !== minion.entityId);
  const played = run(deps.simulator, setup, board, hand, options.verifySims, VERIFY_SEED_PLAYED);
  const alt = run(deps.simulator, setup, [...board, minion], handAfter, options.verifySims, VERIFY_SEED_ALT);
  return recountOf(AGAINST_OPPONENT, played, alt, true);
}

export type PositionJudgement =
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'fine' }
  | {
      readonly kind: 'fact' | 'assumption';
      readonly bestBoard: readonly Minion[];
      /** Против фактического соперника — графа влияния. */
      readonly actual: BattleRecount;
      /** Против поля хода; `null` — поля на этом ходу нет или оно мало. */
      readonly field: BattleRecount | null;
      /** Почему не факт — пусто у факта. */
      readonly reasons: readonly string[];
    };

/** Тот же порядок сущностей на другом снимке борда; `null` — состав разный. */
function reorder(board: readonly Minion[], order: readonly Minion[]): Minion[] | null {
  const out: Minion[] = [];
  for (const m of order) {
    const found = board.find((x) => x.entityId === m.entityId);
    if (found === undefined) return null;
    out.push(found);
  }
  return out.length === board.length ? out : null;
}

/**
 * Расстановка задним числом — три яруса.
 *
 * ФАКТ: лучшая различимо лучше сыгранной против поля хода не меньше чем
 * на `factFieldGapPp`, вывод держится и на борде эпизода, поле собрано
 * на игре того же билда, платного края тринкета нет.
 * ПРЕДПОЛОЖЕНИЕ: лучше против фактического соперника, разница
 * ≥ `guessGapPp` — или факт, не прошедший одно из условий выше (причина
 * пишется).
 * Всё прочее — молчание.
 */
export function judgePositioning(
  setup: BattleSetup,
  episode: BattleEpisode,
  state: GameState,
  tavernTurn: number,
  deps: RecountDeps,
  options: RecountOptions = DEFAULT_RECOUNT_OPTIONS,
): PositionJudgement {
  if (tavernTurn <= 1) return { kind: 'skip', reason: 'первый ход таверны — бой один на один (D087)' };
  if (setup.playerBoard.length < 2) return { kind: 'skip', reason: 'на борде меньше двух миньонов' };
  if (setup.opponentBoard.length === 0) return { kind: 'skip', reason: 'борд соперника пуст' };
  // Бафф «соседям» конца хода (Surfing Sylvar) советник накладывает на
  // каждого кандидата сам (D095), а борд перед TURN его уже несёт:
  // у сыгранной прибавка задвоится, у альтернатив ляжет поверх чужой.
  if (endOfTurnAuraGains(setup.playerBoard, deps.simulator.cards).size > 0) {
    return { kind: 'skip', reason: 'на борде бафф соседям конца хода — счёт расстановки его задвоил бы' };
  }

  const hand = setup.playerHand;
  const played = run(deps.simulator, setup, setup.playerBoard, hand, options.verifySims, VERIFY_SEED_PLAYED);
  // Предусловие DoD фазы 2: если фактический исход при сыгранной
  // расстановке почти невозможен, симулятор этот бой не понимает,
  // и судить расстановку его числами нельзя (part53, ход 26: обещано
  // 99.8 %, бой проигран).
  if (actualOutcomePct(played, episode.outcome) < options.outlierPct) {
    return { kind: 'skip', reason: 'фактический исход — выброс для симулятора' };
  }

  const advice = advisePosition(setup, { simulator: deps.simulator }, NO_BUDGET);
  const best = advice.top[0];
  if (best === undefined || best.key === advice.current.key) return { kind: 'fine' };

  const alt = run(deps.simulator, setup, best.board, hand, options.verifySims, VERIFY_SEED_ALT);
  const actual = recountOf(AGAINST_OPPONENT, played, alt, true);
  const gain = actual.alternative.scorePct - actual.played.scorePct;

  const boards = deps.field === null ? [] : boardsOfTurn(deps.field, tavernTurn, deps.excludePart);
  const fieldBases = (): ((board: readonly Minion[]) => Estimate) => {
    const bases = boards.map((b) =>
      toBattleInfo(
        {
          ...setup,
          opponentBoard: b.board,
          opponentTrinketDbfIds: b.trinketDbfIds,
          opponentGlobalInfo: undefined,
          opponentDeity: undefined,
        },
        options.fieldSimsPerBoard,
      ),
    );
    return (board) => {
      let merged = EMPTY_ESTIMATE;
      bases.forEach((base, i) => {
        merged = mergeEstimates(
          merged,
          toEstimate(
            withSeededRandom(FIELD_SEED * 31 + i, () =>
              deps.simulator.run(withPlayerBoard(base, board), options.fieldSimsPerBoard),
            ),
          ),
        );
      });
      return merged;
    };
  };

  let field: BattleRecount | null = null;
  let onField: ((board: readonly Minion[]) => Estimate) | null = null;
  if (boards.length >= options.minFieldBoards) {
    onField = fieldBases();
    field = recountOf(
      `против поля хода (${boardsWord(boards.length)})`,
      onField(setup.playerBoard),
      onField(best.board),
      false,
    );
  }

  const fieldGain = field === null ? 0 : field.alternative.scorePct - field.played.scorePct;
  const fieldSays = field !== null && field.distinguishable && fieldGain >= options.factFieldGapPp;
  if (!fieldSays) {
    return actual.distinguishable && gain >= options.guessGapPp
      ? { kind: 'assumption', bestBoard: best.board, actual, field, reasons: [] }
      : { kind: 'fine' };
  }

  // Против поля лучшая лучше — осталось убедиться, что это не артефакт
  // модели и что поле говорит о той же игре.
  const epPlayed = reorder(episode.playerBoard, setup.playerBoard);
  const epBest = reorder(episode.playerBoard, best.board);
  let robust: boolean | null = null;
  if (onField !== null && epPlayed !== null && epBest !== null) {
    const a = onField(epPlayed);
    const b = onField(epBest);
    robust = distinguishable(b, a, 'winRate') && objectiveOf(b, 'winRate') > objectiveOf(a, 'winRate');
  }
  const reasons = notFactReasons({
    robust,
    fieldBuild: fieldBuild(deps.field),
    gameBuild: deps.gameBuild,
    paidSlotSources: paidSlots(state, deps.cards).map((p) => p.source),
    positionalSources: positionalEndOfTurn(state, deps.cards),
  });
  return { kind: reasons.length === 0 ? 'fact' : 'assumption', bestBoard: best.board, actual, field, reasons };
}

const END_OF_TURN = /\bend of (?:your |each )?turn\b/i;
/** «right- most» у Sulfuras пишется с пробелом после дефиса. */
const POSITIONAL = /\b(?:adjacent|left-?\s*most|right-?\s*most)\b/i;

/**
 * Карты борда и сила героя, которые в конце хода усиливают СОСЕДЕЙ или КРАЙ:
 * Sulfuras («give your left and right- most minions +8/+8»), Parasitic
 * Fleshling, Timewarped Painter и Sensei, Young Murk-Eye — 24 карты пула.
 * Борд перед боем уже несёт их прибавку для сыгранного порядка, а «лучший»
 * порядок получает её на чужих местах, и место решает не только бой
 * (ревью: part64, ход 9 с подставленной Sulfuras оставался фактом).
 * Тринкеты того же рода — в `paidSlots`.
 */
export function positionalEndOfTurn(state: GameState, cards: CardIndex): string[] {
  const ids = [...state.board.map((m) => m.cardId), state.hero?.heroPowerCardId ?? null].filter(
    (id): id is string => id !== null,
  );
  const names = new Set<string>();
  for (const id of ids) {
    const info = cards.info(id);
    const text = (info?.text ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
    if (END_OF_TURN.test(text) && POSITIONAL.test(text)) names.add(info?.name ?? id);
  }
  return [...names];
}

/**
 * Почему расстановка, лучшая против поля, всё же не факт. Пусто — факт.
 *
 * Отдельной чистой функцией, потому что каждое условие — отдельный
 * урок фактуры, и проверять их надо по одному, а не только на живом бою:
 *
 *  - `robust`: вывод на втором снимке борда (эпизод боя). `null` — состав
 *    борда в бою другой, и проверить нечем (в эталоне критика вывод
 *    от источника борда менялся в 7 боях из 40);
 *  - поле собрано на другой игре — пул карт другой (после ротации 22.09
 *    у 357 из 662 бордов поля есть карты вне пула);
 *  - тринкет платит краю борда каждый ход: part52, бой 16 — Cord Puller
 *    первым стоял под Emergency Gearblade, и «лучшая по бою» расстановка
 *    отдала бы выплату. Разведка считала этот бой единственной ошибкой
 *    расстановки на четырёх партиях.
 */
export function notFactReasons(input: {
  readonly robust: boolean | null;
  readonly fieldBuild: number | null;
  readonly gameBuild: number | null;
  readonly paidSlotSources: readonly string[];
  /** Карты борда и сила, в конце хода усиливающие соседей или край. */
  readonly positionalSources?: readonly string[];
}): string[] {
  const reasons: string[] = [];
  if (input.robust === null) {
    reasons.push('проверить вывод на втором снимке борда (эпизод боя) нельзя: состав борда в бою другой');
  } else if (!input.robust) {
    reasons.push('на втором снимке борда (эпизод боя) разница не держится — вывод зависит от модели');
  }
  if (!sameGameBuild(input.fieldBuild, input.gameBuild)) {
    reasons.push(
      `поле бордов собрано на билде ${String(input.fieldBuild)}, а партия — на ${String(input.gameBuild)}: пул карт другой`,
    );
  }
  if (input.paidSlotSources.length > 0) {
    reasons.push(
      `тринкет ${input.paidSlotSources.join(', ')} платит краю борда каждый ход — расстановка решает не только бой`,
    );
  }
  const positional = input.positionalSources ?? [];
  if (positional.length > 0) {
    reasons.push(
      `${positional.join(', ')} в конце хода усиливает соседей или край борда — порядок решает не только бой`,
    );
  }
  return reasons;
}
