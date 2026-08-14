import { endOfTurnAuraGains, withEndOfTurnAuras } from '../battle/endOfTurn.js';
import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../battle/mapper.js';
import type { BattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import type { PositionTarget } from '../position/opponent.js';
import type { GameState, Minion } from '../../state/types.js';
import type { TavernAdvice } from './advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from './rules.js';

/**
 * Досчёт покупок симулятором — для живого режима.
 *
 * Эвристика покупок совпадает с симулятором на 81% ходов, но на решающих —
 * только на 64% (замер `npm run validate:tavern`, docs/tavern.md). Это предел
 * жанра: решающий ход и есть тот, где нужен счёт боя, а не таблица весов.
 * Досчёт прогоняет верхние покупки через симулятор против той же цели,
 * что у советника расстановки, и говорит, что покупка даёт В БОЮ.
 *
 * ## Против кого — та же цель, что у расстановки
 *
 * Следующий противник, если его борд видели, иначе поле всех виденных бордов
 * со счётом, поделённым поровну (`battleQuestion`). Ранние ходы до первого
 * боя честно молчат: цели нет. Оффлайн-сверка берёт фактический борд боя
 * следующего хода — живому советнику это знание недоступно, поэтому его
 * числа НЕ сравнимы с числами сверки и подписываются давностью картинки.
 *
 * ## Что остаётся за скобками — та же методика, что у сверки
 *
 *  - кандидат ставится в конец борда, без поиска расстановки, магнитный —
 *    телом; политика одна для всех кандидатов, на их порядок влияет слабо;
 *  - покупка «в руку» на полном борде (вторая копия, тройка со слиянием)
 *    ближайший бой не меняет — такие кандидаты не досчитываются;
 *  - экономику и задел на будущее бой не видит: досчёт ДОПОЛНЯЕТ эвристику
 *    строкой «по бою», а не подменяет её порядок.
 */

export interface BuyCandidate {
  readonly cardId: string;
  readonly entityId: number;
  /** Борд, каким он выйдет в бой: жертва продана, кандидат в конце. */
  readonly boardAfter: readonly Minion[];
}

export interface BuyCheckQuestion {
  /** По сетапу на борд цели — как у расстановки. */
  readonly setups: readonly BattleSetup[];
  readonly target: PositionTarget;
  /** Кандидаты в порядке эвристики: первый — её выбор. */
  readonly candidates: readonly BuyCandidate[];
}

export interface BuyCheckOptions {
  /** Симуляций на кандидата; между бордами поля делятся поровну. */
  readonly simulations: number;
  /** Сколько верхних покупок досчитывать. */
  readonly maxCandidates: number;
}

export const DEFAULT_BUY_CHECK_OPTIONS: BuyCheckOptions = {
  // 800 на кандидата: ~120 мкс на симуляцию — три кандидата укладываются
  // в полсекунды, а шум разности долей (~2.5 п.п.) остаётся ниже разрывов,
  // которые стоили промахов в сверке (7+ п.п.).
  simulations: 800,
  maxCandidates: 3,
};

/**
 * Что досчитывать: верхние покупки, каждая — бордом «как выйдет в бой».
 *
 * `null`, когда досчитывать нечего: не таверна, цели нет, покупок меньше
 * двух разных. Две копии одной карты — одно решение, как в оффлайн-сверке.
 */
export function buyCheckQuestion(
  state: GameState,
  advice: TavernAdvice,
  rules: TavernRules = DEFAULT_TAVERN_RULES,
  options: BuyCheckOptions = DEFAULT_BUY_CHECK_OPTIONS,
): BuyCheckQuestion | null {
  if (state.phase !== 'tavern') return null;
  const question = battleQuestion(state);
  if (question === null) return null;

  const full = state.board.length >= rules.boardSize;
  const seen = new Set<string>();
  const candidates: BuyCandidate[] = [];
  for (const r of advice.recommendations) {
    if (candidates.length >= options.maxCandidates) break;
    if (r.action !== 'buy' || r.minion === null) continue;
    // Покупка «в руку» на полном борде (вторая копия, тройка со слиянием)
    // ближайший бой не меняет — сравнивать её боем не с чем.
    if (full && r.sellFirst === null) continue;
    if (seen.has(r.minion.cardId)) continue;
    seen.add(r.minion.cardId);

    const sellFirst = r.sellFirst;
    candidates.push({
      cardId: r.minion.cardId,
      entityId: r.minion.entityId,
      boardAfter: [
        ...state.board.filter((m) => sellFirst === null || m.entityId !== sellFirst.entityId),
        r.minion,
      ],
    });
  }
  if (candidates.length < 2) return null;

  return { setups: question.setups, target: question.target, candidates };
}

/** Счёт брошен: положение ушло вперёд, ответ никому не нужен. */
export class BuyCheckAborted extends Error {
  constructor() {
    super('досчёт покупок брошен');
  }
}

export interface BuyOutcome {
  readonly cardId: string;
  readonly entityId: number;
  /** Симуляций всего на кандидата. */
  readonly sims: number;
  /** Ожидаемый исход, %: победа плюс половина ничьей. */
  readonly outcome: number;
}

export interface BuyCheckResult {
  /** По убыванию исхода. */
  readonly outcomes: readonly BuyOutcome[];
  /** Разброс исходов лучший−худший, п.п. */
  readonly spread: number;
  /**
   * Порог шума, п.п.: два стандартных отклонения разности двух долей
   * при этом числе симуляций. Ниже него разброс — дрожание счёта,
   * и «лучший» кандидат от прогона к прогону случаен (см. правило
   * порога в оффлайн-сверке, docs/tavern.md).
   */
  readonly noise: number;
  /** Разброс превышает шум: досчёт что-то решил. */
  readonly decisive: boolean;
  /** Совпал ли лучший по бою с выбором эвристики — по карте. */
  readonly agreed: boolean;
  readonly elapsedMs: number;
}

export interface BuyCheckDeps {
  readonly simulator: BattleSimulator;
  /** Проверяется между прогонами; `true` — бросить счёт. */
  readonly aborted?: () => boolean;
}

/**
 * Прогнать кандидатов через бой. Синхронный — живой режим зовёт из воркера.
 *
 * Поле бордов считается послойно, как у расстановки: симуляции кандидата
 * делятся между бордами поровну, исход — среднее. Это то же «среднее по
 * полю», что в `spike:field`, только на один борд-вариант на кандидата.
 */
export function checkBuysWithBattle(
  question: Pick<BuyCheckQuestion, 'setups' | 'candidates'>,
  deps: BuyCheckDeps,
  options: BuyCheckOptions = DEFAULT_BUY_CHECK_OPTIONS,
): BuyCheckResult {
  const started = Date.now();
  const boards = Math.max(1, question.setups.length);
  const perBoard = Math.max(1, Math.ceil(options.simulations / boards));
  const bases = question.setups.map((s) => toBattleInfo(s, perBoard));

  const outcomes = question.candidates.map((candidate) => {
    // Баффы «соседям» конца хода — как у расстановки: борд кандидата идёт
    // в бой уже с ними (Surfing Sylvar, part16).
    const board = withEndOfTurnAuras(
      candidate.boardAfter,
      endOfTurnAuraGains(candidate.boardAfter, deps.simulator.cards),
    );
    let outcomeSum = 0;
    for (const base of bases) {
      if (deps.aborted?.() ?? false) throw new BuyCheckAborted();
      const result = deps.simulator.run(withPlayerBoard(base, board), perBoard);
      outcomeSum += result.wonPercent + result.tiedPercent / 2;
    }
    return {
      cardId: candidate.cardId,
      entityId: candidate.entityId,
      sims: perBoard * bases.length,
      outcome: outcomeSum / bases.length,
    };
  });

  const sorted = [...outcomes].sort((a, b) => b.outcome - a.outcome);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];
  const spread = best !== undefined && worst !== undefined ? best.outcome - worst.outcome : 0;
  const sims = best?.sims ?? options.simulations;
  // Стандартное отклонение разности двух независимых долей около 50%:
  // sqrt(2·p(1−p)/N)·100 п.п. Порог — два таких отклонения.
  const noise = 2 * Math.sqrt((2 * 0.25) / sims) * 100;

  return {
    outcomes: sorted,
    spread,
    noise,
    decisive: spread >= noise,
    agreed: best !== undefined && best.cardId === question.candidates[0]?.cardId,
    elapsedMs: Date.now() - started,
  };
}
