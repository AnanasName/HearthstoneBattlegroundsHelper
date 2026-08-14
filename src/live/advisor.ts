import type { BattleSetup } from '../advisors/battle/mapper.js';
import type { PositionAdvice } from '../advisors/position/advisor.js';
import { positionQuestion } from '../advisors/position/advisor.js';
import {
  resolveOpponent,
  type PositionTarget,
  type ResolvedOpponent,
} from '../advisors/position/opponent.js';
import type { SearchOptions } from '../advisors/position/search.js';
import { adviseTavern, type TavernAdvice } from '../advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES, type TavernRules } from '../advisors/tavern/rules.js';
import type { CardIndex } from '../data/cards.js';
import type { GameState, Minion } from '../state/types.js';

/**
 * Когда звать советников и когда бросать начатое.
 *
 * Живой режим отличается от демо не тем, что состояние приходит по кускам,
 * а тем, что оно меняется под руками. Два правила, из которых всё следует:
 *
 * 1. **Советовать по положению дел, а не по событию.** Событий в фазе таверны
 *    сотни, а положений — единицы: игрок купил, продал, обновил витрину.
 *    Поэтому считается ключ положения, и совпавший ключ работы не поднимает.
 *
 * 2. **Устаревший счёт бросать, а не дожидаться.** Совет по расстановке
 *    считается секунды. Если за это время борд изменился, досчитанный ответ
 *    относится к тому, чего уже нет, — он не «слегка устарел», он неверен.
 *
 * Плюс задержка на затишье: игрок покупает миньона тремя событиями подряд,
 * и считать на каждом промежуточном — впустую жечь те же секунды.
 */

/**
 * Кто считает расстановку.
 *
 * Интерфейс, а не сам воркер: правила «когда звать и когда бросать» проверяются
 * тестами за миллисекунды, а поднимать ради них поток со снапшотом карт значит
 * проверять заодно и симулятор — он проверен в фазе 3.
 */
export interface PositionSource {
  advise(
    setups: readonly BattleSetup[],
    overrides?: Partial<SearchOptions>,
  ): Promise<PositionAdvice | null>;
  cancel(): void;
}

export interface LiveAdvisorDeps {
  readonly cards: CardIndex;
  readonly position: PositionSource;
}

export interface LiveAdvisorOptions {
  /** Сколько тишины ждать, прежде чем считать. */
  readonly quietMs: number;
  readonly rules: TavernRules;
  readonly search: Partial<SearchOptions>;
}

export const DEFAULT_LIVE_ADVISOR_OPTIONS: LiveAdvisorOptions = {
  // Треть секунды: покупка миньона отпечатывается в логе за десятки
  // миллисекунд, а игрок следующее действие так быстро не делает.
  quietMs: 350,
  rules: DEFAULT_TAVERN_RULES,
  search: {},
};

export interface LiveAdvisorHandlers {
  /** Быстрый совет по таверне; готов сразу. */
  readonly onTavern?: (advice: TavernAdvice | null, state: GameState) => void;
  /** Счёт расстановки начат — интерфейсу пора показать, что он думает. */
  readonly onThinking?: (state: GameState) => void;
  /** Счёт расстановки закончен. `null` — бросили, положение ушло вперёд. */
  readonly onPosition?: (
    advice: PositionAdvice | null,
    target: PositionTarget,
    state: GameState,
  ) => void;
  /**
   * Расстановку считать не на чем: ни противника, ни единого виденного борда.
   *
   * С целью-полем это уже не полпартии, а только первые ходы до первого боя:
   * дальше хоть один борд виден, и счёт идёт против поля. Но молчать и здесь
   * нельзя — со стороны неотличимо от сломанного советника.
   */
  readonly onNoOpponent?: (opponent: ResolvedOpponent, state: GameState) => void;
  readonly onError?: (error: Error) => void;
}

/** Отпечаток миньона: всё, от чего зависит бой. */
function minionKey(m: Minion): string {
  return [
    m.entityId,
    m.cardId,
    m.zonePos,
    m.attack ?? '?',
    m.health ?? '?',
    m.golden ? 'g' : '',
    m.taunt ? 't' : '',
    m.divineShield ? 'd' : '',
    m.poisonous ? 'p' : '',
    m.venomous ? 'v' : '',
    m.reborn ? 'r' : '',
    m.windfury ? 'w' : '',
    m.enchantments.length,
  ].join(':');
}

/**
 * Ключ положения дел.
 *
 * Сюда входит всё, от чего зависит хоть один совет, и не входит ничего
 * другого: иначе каждое служебное событие считалось бы новым положением.
 */
export function situationKey(state: GameState): string {
  return [
    state.phase,
    state.turn,
    state.techLevel,
    state.gold,
    state.tavernUpgradeCost ?? '-',
    state.hero === null ? '-' : `${String(state.hero.health ?? 0)}/${String(state.hero.damage)}`,
    state.nextOpponentPlayerId ?? '-',
    state.board.map(minionKey).join(','),
    state.shop.map(minionKey).join(','),
    state.hand.map((m) => m.cardId).join(','),
    // Предложение тринкетов открывается посреди хода, не меняя ни золота,
    // ни бордов. Без него в ключе оверлей не просыпался бы на открытие
    // выбора и совет по тринкету никто бы не увидел.
    state.trinketOffer.map((t) => t.entityId).join(','),
  ].join('|');
}

export class LiveAdvisor {
  readonly #deps: LiveAdvisorDeps;
  readonly #options: LiveAdvisorOptions;
  readonly #handlers: LiveAdvisorHandlers;

  #key = '';
  #pending: GameState | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    deps: LiveAdvisorDeps,
    handlers: LiveAdvisorHandlers,
    overrides: Partial<LiveAdvisorOptions> = {},
  ) {
    this.#deps = deps;
    this.#handlers = handlers;
    this.#options = { ...DEFAULT_LIVE_ADVISOR_OPTIONS, ...overrides };
  }

  /** Положение дел изменилось. Звать можно хоть на каждое событие. */
  update(state: GameState | null): void {
    if (state === null) return;

    const key = situationKey(state);
    if (key === this.#key) return;
    this.#key = key;

    // Отмена идёт сразу, не дожидаясь затишья: то, что считается сейчас,
    // уже относится к прошлому положению, и досчитывать его незачем.
    this.#deps.position.cancel();

    this.#pending = state;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const waiting = this.#pending;
      this.#pending = null;
      if (waiting !== null) this.#advise(waiting, key);
    }, this.#options.quietMs);
  }

  /** Забыть незаконченное: партия сменилась или приложение закрывается. */
  reset(): void {
    this.#key = '';
    this.#pending = null;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#deps.position.cancel();
  }

  #advise(state: GameState, key: string): void {
    this.#handlers.onTavern?.(adviseTavern(state, this.#deps, this.#options.rules), state);

    // Расстановка нужна в таверне: в бою переставлять уже нечего.
    if (state.phase !== 'tavern') return;

    const question = positionQuestion(state);
    if (question === null) {
      if (state.board.length > 0) this.#handlers.onNoOpponent?.(resolveOpponent(state), state);
      return;
    }

    this.#handlers.onThinking?.(state);
    this.#deps.position
      .advise(question.setups, this.#options.search)
      .then((advice) => {
        // Ключ мог смениться, пока считали: тогда ответ уже не про это
        // положение, и показывать его нельзя. Но и промолчать нельзя —
        // «не успели» это тоже ответ, и интерфейс обязан его показать,
        // иначе неотличимо от «советник не работает».
        this.#handlers.onPosition?.(key === this.#key ? advice : null, question.target, state);
      })
      .catch((error: unknown) => {
        this.#handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
  }
}
