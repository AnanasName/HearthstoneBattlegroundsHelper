import { DEFAULT_LOGS_ROOT, findLatestPowerLog } from '../watcher/logPaths.js';
import { FileTailer } from '../watcher/tail.js';
import type { GameState } from '../state/types.js';
import { GameFeed, type FeedGame } from './feed.js';
import { LineAssembler } from './lines.js';

/**
 * Живой цикл: Power.log → состояние партии, пока приложение работает.
 *
 * ## Почему файл читается с начала
 *
 * Приложение запускают когда придётся — в том числе посреди партии. Состояние
 * собирается только из полной истории: дамп CREATE_GAME лежит в начале файла,
 * и без него неизвестно даже, кто из игроков сам игрок. Поэтому файл читается
 * целиком (41 МБ эталонной партии — около секунды), и лишь потом начинается
 * слежение за дописыванием.
 *
 * ## Смена файла — забота этого цикла, а не игрока
 *
 * Hearthstone заводит новую папку логов на каждый запуск клиента и в старую
 * больше не пишет. Игрок клиент перезапускает — от обновления игры до вылета.
 * Требовать за это перезапуска помощника нельзя, поэтому появление свежей
 * сессии проверяется на ходу и слежение переключается само.
 */

export interface LiveWatcherOptions {
  readonly logsRoot: string;
  /** Как часто спрашивать файл о новых байтах. */
  readonly pollMs: number;
  /** Как часто искать свежую сессию клиента. */
  readonly sessionCheckMs: number;
}

export const DEFAULT_WATCHER_OPTIONS: LiveWatcherOptions = {
  logsRoot: DEFAULT_LOGS_ROOT,
  // Четверть секунды: игрок за это время ничего не успевает, а нагрузка
  // от опроса файла неощутима.
  pollMs: 250,
  sessionCheckMs: 5000,
};

export interface LiveUpdate {
  readonly state: GameState | null;
  readonly game: FeedGame | null;
  /** Это чтение того, что было в файле до запуска, а не свежие события. */
  readonly catchingUp: boolean;
  readonly path: string;
}

/** Событие, о котором стоит сказать вслух, но которое не меняет совета. */
export type LiveNotice =
  | { readonly kind: 'noLog'; readonly logsRoot: string }
  | { readonly kind: 'watching'; readonly path: string }
  | { readonly kind: 'switched'; readonly path: string }
  | { readonly kind: 'restarted'; readonly path: string }
  | { readonly kind: 'caughtUp'; readonly events: number; readonly bytes: number; readonly ms: number }
  | { readonly kind: 'newGame'; readonly id: number; readonly player: string | null };

export class LiveWatcher {
  readonly #options: LiveWatcherOptions;
  readonly #onUpdate: (update: LiveUpdate) => void;
  readonly #onNotice: (notice: LiveNotice) => void;

  #tailer: FileTailer | null = null;
  #lines = new LineAssembler();
  #feed = new GameFeed();
  #catchingUp = true;
  #announced = 0;
  #timer: NodeJS.Timeout | null = null;
  #sessionCheckedAt = 0;
  #stopped = false;
  #ticking = false;

  constructor(
    handlers: {
      readonly onUpdate: (update: LiveUpdate) => void;
      readonly onNotice?: (notice: LiveNotice) => void;
    },
    overrides: Partial<LiveWatcherOptions> = {},
  ) {
    this.#options = { ...DEFAULT_WATCHER_OPTIONS, ...overrides };
    this.#onUpdate = handlers.onUpdate;
    this.#onNotice = handlers.onNotice ?? ((): void => undefined);
  }

  start(): void {
    const path = findLatestPowerLog(this.#options.logsRoot);
    if (path === null) {
      this.#onNotice({ kind: 'noLog', logsRoot: this.#options.logsRoot });
    } else {
      this.#attach(path);
      this.#onNotice({ kind: 'watching', path });
    }

    this.#sessionCheckedAt = Date.now();
    this.#timer = setInterval(() => void this.#tick(), this.#options.pollMs);
    // Первый опрос сразу: ждать четверть секунды впустую незачем.
    void this.#tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** Текущее состояние, если оно уже собрано. */
  snapshot(): GameState | null {
    return this.#feed.snapshot();
  }

  #attach(path: string): void {
    this.#tailer = new FileTailer(path);
    this.#reset();
  }

  #reset(): void {
    this.#lines = new LineAssembler();
    this.#feed = new GameFeed();
    this.#catchingUp = true;
    this.#announced = 0;
  }

  async #tick(): Promise<void> {
    // Чтение асинхронно, а опрос идёт по таймеру: без этого замка длинное
    // первое чтение накладывалось бы само на себя.
    if (this.#ticking || this.#stopped) return;
    this.#ticking = true;
    try {
      await this.#poll();
    } finally {
      this.#ticking = false;
    }
  }

  async #poll(): Promise<void> {
    this.#checkForNewerSession();

    const tailer = this.#tailer;
    if (tailer === null) return;

    const started = Date.now();
    const { data, restarted } = await tailer.read();

    if (restarted) {
      // Файл стал короче прочитанного: его обрезали или подменили. Досчитывать
      // старое состояние не по чему — собираем заново с того, что есть.
      this.#reset();
      this.#onNotice({ kind: 'restarted', path: tailer.path });
    }

    const catchingUp = this.#catchingUp;
    if (data.length > 0) {
      this.#feed.pushLines(this.#lines.push(data));
      this.#announceNewGames(catchingUp);
    }

    if (catchingUp) {
      // Догон — это ровно одно чтение: `FileTailer` за раз отдаёт весь хвост
      // до конца файла, поэтому после первого же чтения мы уже на конце.
      this.#catchingUp = false;
      this.#onNotice({
        kind: 'caughtUp',
        events: this.#feed.events,
        bytes: data.length,
        ms: Date.now() - started,
      });
    }

    if (data.length === 0) return;

    this.#onUpdate({
      state: this.#feed.snapshot(),
      game: this.#feed.game,
      catchingUp,
      path: tailer.path,
    });
  }

  #announceNewGames(catchingUp: boolean): void {
    const seen = this.#feed.gamesSeen;
    while (this.#announced < seen) {
      this.#announced += 1;
      // На догоне о прошлых партиях объявлять незачем: они уже сыграны.
      // Интересна только та, что идёт сейчас.
      if (catchingUp && this.#announced < seen) continue;
      this.#onNotice({
        kind: 'newGame',
        id: this.#announced,
        player: this.#feed.game?.players.selfName ?? null,
      });
    }
  }

  #checkForNewerSession(): void {
    const now = Date.now();
    if (now - this.#sessionCheckedAt < this.#options.sessionCheckMs) return;
    this.#sessionCheckedAt = now;

    const latest = findLatestPowerLog(this.#options.logsRoot);
    if (latest === null || latest === this.#tailer?.path) return;

    this.#attach(latest);
    this.#onNotice({ kind: 'switched', path: latest });
  }
}
