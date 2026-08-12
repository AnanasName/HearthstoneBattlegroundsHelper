import { parseLogLine, splitLogLines } from '../parser/logLine.js';
import { GameFeed } from './feed.js';

/**
 * Проигрывание записанного лога через живой путь.
 *
 * Зачем это нужно. Живой режим нечем показать без запущенной игры, а проверять
 * его на игре — значит проверять раз в партию и без повторяемости. Здесь тот же
 * `GameFeed` и те же советники получают ту же партию, только строки приходят
 * не от клиента, а из фикстуры.
 *
 * ## Почему по часам лога, а не порциями подряд
 *
 * Советники ждут затишья: считать на каждое из сотен событий фазы таверны
 * незачем. Если гнать строки без пауз, затишья не наступит ни разу и совета
 * не будет вовсе — проигрывание показывало бы работающий разбор и молчащий
 * советник. Поэтому паузы берутся из отметок времени самого лога и делятся
 * на ускорение.
 */

export interface ReplayOptions {
  /** Во сколько раз быстрее настоящего времени. */
  readonly speed: number;
  /** Предел одной паузы, мс: длинные простои проматываются. */
  readonly maxGapMs: number;
  /** Паузы короче этого не выдерживаются — их не заметит никто, а вызовов много. */
  readonly minGapMs: number;
}

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  // Двадцатикратное ускорение: партия на 23 минуты проигрывается за минуту,
  // а ход таверны в полминуты — за полторы секунды. Этого хватает, чтобы
  // затишье наступило и советник успел ответить.
  speed: 20,
  maxGapMs: 1500,
  minGapMs: 20,
};

export interface ReplayHandlers {
  readonly onUpdate: (feed: GameFeed) => void;
  readonly onDone?: (feed: GameFeed) => void;
}

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})\.(\d+)/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Отметка времени строки в миллисекундах от полуночи. */
function timeOf(raw: string): number | null {
  const line = parseLogLine(raw);
  if (line === null) return null;

  const m = TIME_RE.exec(line.time);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined) return null;

  const fraction = m[4] ?? '0';
  return (
    Number(m[1]) * 3_600_000 +
    Number(m[2]) * 60_000 +
    Number(m[3]) * 1000 +
    Number(`0.${fraction}`) * 1000
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function replayLog(
  text: string,
  handlers: ReplayHandlers,
  overrides: Partial<ReplayOptions> = {},
): Promise<GameFeed> {
  const options = { ...DEFAULT_REPLAY_OPTIONS, ...overrides };
  const feed = new GameFeed();

  let batch: string[] = [];
  let previous: number | null = null;

  const flush = (): void => {
    if (batch.length === 0) return;
    feed.pushLines(batch);
    batch = [];
    handlers.onUpdate(feed);
  };

  for (const raw of splitLogLines(text)) {
    const now = timeOf(raw);

    if (now !== null && previous !== null) {
      // Партия переваливает за полночь — эталонная начинается в 23:53.
      // Отрицательный промежуток означает именно это, а не скачок назад.
      const gap = now < previous ? now + DAY_MS - previous : now - previous;
      const wait = Math.min(gap / options.speed, options.maxGapMs);
      if (wait >= options.minGapMs) {
        flush();
        await sleep(wait);
      }
    }

    if (now !== null) previous = now;
    batch.push(raw);
  }

  flush();
  handlers.onDone?.(feed);
  return feed;
}
