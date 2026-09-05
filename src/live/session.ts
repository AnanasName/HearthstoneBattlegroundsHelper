import type { CardIndex } from '../data/cards.js';
import type { GameState } from '../state/types.js';
import {
  LiveAdvisor,
  type BuyCheckSource,
  type LiveAdvisorHandlers,
  type LiveAdvisorOptions,
  type PositionSource,
} from './advisor.js';
import { CardsFreshness } from './freshness.js';
import { LiveWatcher, type LiveNotice, type LiveWatcherOptions } from './watcher.js';

/**
 * Склейка слежения за логом и советников.
 *
 * Живёт отдельным модулем не ради красоты: и терминал, и оверлей связывали
 * их сами, одинаково — и одинаково неверно.
 *
 * ## Состояние в конце догона — это «сейчас», а не история
 *
 * Первое чтение забирает весь файл, накопившийся до запуска помощника. Правило
 * «на догоне не советуем» выглядело очевидным — события уже сыграны, советовать
 * по ним поздно. Но `LiveWatcher` зовёт обновление один раз на чтение, после
 * применения всех строк, поэтому единственное обновление догона несёт
 * АКТУАЛЬНОЕ состояние: то, что в игре прямо сейчас.
 *
 * Правило это состояние и выбрасывало. Игрок, запустивший помощник посреди
 * партии, видел «новая партия» и дальше ничего — до первой перемены в игре,
 * а в меню её можно ждать сколько угодно. Поэтому советуется каждое
 * обновление, включая догон.
 */

export interface LiveSessionDeps {
  readonly cards: CardIndex;
  readonly position: PositionSource;
  /** Досчёт покупок боем; без него покупки живут одной эвристикой. */
  readonly buys?: BuyCheckSource;
  /**
   * Накопитель датасета партий (фаза 6): каждое обновление состояния
   * и сброс на новой партии. Без него партии в датасет не пишутся.
   */
  readonly dataset?: {
    update: (state: GameState) => void;
    reset: () => void;
  };
  /**
   * Прогноз места (фаза 6): тот же поток состояний, что у датасета.
   *
   * Отдельной зависимостью, а не внутри советника: прогноз читает ИСТОРИЮ
   * точек решения партии, а советник зовётся по смене положения дел
   * и промежуточных состояний не видит. Правило точки у него общее
   * с рекордером (`DecisionPoints`), значит и поток обязан быть тем же —
   * каждое обновление и сброс на новой партии.
   */
  readonly forecast?: {
    update: (state: GameState) => void;
    reset: () => void;
  };
}

export interface LiveSessionHandlers extends LiveAdvisorHandlers {
  readonly onNotice?: (notice: LiveNotice) => void;
  /**
   * Снапшот карт отстал от патча: в партии слишком много незнакомых карт,
   * и советы по ним слепые. Раз за партию (`CardsFreshness`).
   */
  readonly onFreshness?: (warning: string) => void;
}

export interface LiveSessionOptions {
  readonly watcher: Partial<LiveWatcherOptions>;
  readonly advisor: Partial<LiveAdvisorOptions>;
}

export interface LiveSession {
  stop: () => void;
}

export function startLiveSession(
  deps: LiveSessionDeps,
  handlers: LiveSessionHandlers,
  options: Partial<LiveSessionOptions> = {},
): LiveSession {
  const { onNotice, onFreshness, ...advisorHandlers } = handlers;

  const advisor = new LiveAdvisor(deps, advisorHandlers, options.advisor);
  const freshness = new CardsFreshness(deps.cards);
  const watcher = new LiveWatcher(
    {
      onUpdate: ({ state }) => {
        advisor.update(state);
        if (state === null) return;
        deps.dataset?.update(state);
        deps.forecast?.update(state);
        const warning = freshness.update(state);
        if (warning !== null) onFreshness?.(warning);
      },
      onNotice: (notice) => {
        // Новая партия: незнакомые карты и точки решения — прошлой.
        if (notice.kind === 'newGame') {
          freshness.reset();
          deps.dataset?.reset();
          deps.forecast?.reset();
        }
        onNotice?.(notice);
      },
    },
    options.watcher,
  );

  watcher.start();

  return {
    stop: () => {
      watcher.stop();
      advisor.reset();
    },
  };
}
