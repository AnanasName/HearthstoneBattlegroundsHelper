import type { BattleSetup } from '../../advisors/battle/mapper.js';
import type { PositionAdvice } from '../../advisors/position/advisor.js';
import type { SearchOptions } from '../../advisors/position/search.js';
import type {
  BuyCandidate,
  BuyCheckOptions,
  BuyCheckResult,
} from '../../advisors/tavern/simulated.js';

/**
 * Разговор с воркером расстановки.
 *
 * ## Зачем воркер
 *
 * Совет по расстановке считается 3–4 секунды и синхронен: пока он идёт,
 * главный поток не читает лог, не рисует и вообще ничего не делает. В демо
 * это незаметно, в живом режиме недопустимо — за эти секунды игрок успевает
 * купить миньона.
 *
 * Второе, ради чего он нужен, — карты. Снапшот весит 38 МБ и разбирается
 * секундами; в воркере он грузится один раз при старте, а не на каждый совет.
 *
 * ## Отмена — общей памятью, а не сообщением
 *
 * Пока воркер считает, он не читает свою очередь сообщений: счёт синхронный.
 * Поэтому «брось считать» передаётся единственным способом, который работает
 * поверх занятого потока, — числом в разделяемой памяти.
 *
 * В этом числе лежит НОМЕР задачи, которую сейчас ждут, а не флаг отмены.
 * Так гонка закрывается сама: воркер бросает счёт, как только номер перестал
 * совпадать с его собственным. Новая задача отменяет предыдущую тем же
 * действием, которым объявляет себя, и отменить «не ту» задачу нельзя.
 * Ноль означает, что не ждут ничего.
 *
 * ## Два вида работы — два слота отмены
 *
 * Воркер считает и расстановку, и досчёт покупок: снапшот карт один,
 * грузить его дважды незачем. Задачи разного вида не отменяют друг друга —
 * у каждого вида своя ячейка в общей памяти (слот 0 — расстановка,
 * слот 1 — покупки). Очередь всё же одна: покупки (полсекунды) советник
 * шлёт ПЕРЕД расстановкой (секунды), чтобы короткий счёт не ждал длинного.
 */

/** Слоты в общей памяти отмены. */
export const POSITION_SLOT = 0;
export const BUYS_SLOT = 1;

export interface AdviseRequest {
  readonly type: 'advise';
  readonly id: number;
  /** По сетапу на борд противника; поле присылает несколько. */
  readonly setups: readonly BattleSetup[];
  readonly overrides: Partial<SearchOptions>;
}

export interface CheckBuysRequest {
  readonly type: 'checkBuys';
  readonly id: number;
  readonly setups: readonly BattleSetup[];
  readonly candidates: readonly BuyCandidate[];
  readonly options: BuyCheckOptions;
}

export type WorkerRequest = AdviseRequest | CheckBuysRequest;

export interface ReadyMessage {
  readonly type: 'ready';
  /** Сколько заняла загрузка справочника карт, мс. */
  readonly loadMs: number;
}

export interface AdviceMessage {
  readonly type: 'advice';
  readonly id: number;
  readonly advice: PositionAdvice;
}

export interface BuysMessage {
  readonly type: 'buys';
  readonly id: number;
  readonly result: BuyCheckResult;
}

export interface AbortedMessage {
  readonly type: 'aborted';
  readonly id: number;
}

export interface FailureMessage {
  readonly type: 'failure';
  readonly id: number;
  readonly message: string;
}

export type WorkerMessage =
  | ReadyMessage
  | AdviceMessage
  | BuysMessage
  | AbortedMessage
  | FailureMessage;

export interface WorkerSetup {
  /** Два 32-битных числа: номера ждущихся задач по слотам видов работы. */
  readonly pending: SharedArrayBuffer;
  readonly cardsPath?: string;
}

/** Номер «ничего не ждём». */
export const NO_TASK = 0;
