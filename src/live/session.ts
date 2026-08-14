import type { CardIndex } from '../data/cards.js';
import {
  LiveAdvisor,
  type BuyCheckSource,
  type LiveAdvisorHandlers,
  type LiveAdvisorOptions,
  type PositionSource,
} from './advisor.js';
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
}

export interface LiveSessionHandlers extends LiveAdvisorHandlers {
  readonly onNotice?: (notice: LiveNotice) => void;
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
  const { onNotice, ...advisorHandlers } = handlers;

  const advisor = new LiveAdvisor(deps, advisorHandlers, options.advisor);
  const watcher = new LiveWatcher(
    {
      onUpdate: ({ state }) => {
        advisor.update(state);
      },
      onNotice,
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
