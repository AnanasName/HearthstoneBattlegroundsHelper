import { PowerEventAssembler, SOURCE_OF_TRUTH } from '../parser/blocks.js';
import { parseLogLine } from '../parser/logLine.js';
import { PlayersCollector, type Players } from '../state/players.js';
import { createReducer, type Reducer } from '../state/reducer.js';
import type { GameState } from '../state/types.js';

/**
 * Лог партия за партией: строки на входе, `GameState` на выходе.
 *
 * Пакетные демо читают файл целиком и знают всё наперёд — в частности, кто
 * из двух объявленных игроков сам игрок. Живому режиму лог приходит порциями,
 * и здесь закрыты два отличия.
 *
 * ## Редьюсер нельзя создать сразу
 *
 * `createReducer` требует готовых `Players`: он замораживает у себя набор
 * сущностей своего игрока. А «кто я» становится известно не в первой строке:
 * объявления `Player` идут в дампе CREATE_GAME (строки 46 и 71 эталонной
 * партии), а имя игрока — только на 242-й, уже в канале DebugPrintGame.
 *
 * Поэтому строки от CREATE_GAME копятся, пока не станет известно всё нужное,
 * и тогда прогоняются в редьюсер с начала. Двести строк буфера — цена того,
 * что живой путь даёт ровно то же состояние, что и пакетный.
 *
 * ## CREATE_GAME начинает новую партию
 *
 * Каждый дамп начинается с этой строки: и новая партия, и переподключение
 * посреди старой (проверено на четырёх кусках part1). Различить их со стороны
 * нечем, поэтому обе трактуются одинаково — состояние собирается заново.
 * Дамп переподключения содержит полное текущее состояние, так что теряется
 * не оно, а история: борды соперников, увиденные до обрыва.
 */

export interface FeedGame {
  /** Порядковый номер партии в этом логе, начиная с 1. */
  readonly id: number;
  readonly players: Players;
}

/** Столько строк ждём «кто я», прежде чем счесть дамп негодным. */
const RESOLVE_LIMIT = 50_000;

export class GameFeed {
  #assembler = new PowerEventAssembler();
  #collector: PlayersCollector | null = null;
  #pending: string[] = [];
  #reducer: Reducer | null = null;
  #game: FeedGame | null = null;
  #games = 0;
  #abandoned = 0;
  #beforeFirstGame = 0;
  #events = 0;

  pushLines(lines: readonly string[]): void {
    for (const line of lines) this.#pushLine(line);
  }

  #pushLine(raw: string): void {
    // Строка CREATE_GAME начинает партию и на этом не исчезает: пакетный путь
    // отдаёт её редьюсеру как обычное событие, и живой обязан делать то же.
    // Съеденная строка стоила ровно одного события расхождения — тег,
    // применённый в пакете и не применённый вживую.
    if (isCreateGame(raw)) this.#startGame();

    if (this.#reducer !== null) {
      const event = this.#assembler.push(raw);
      if (event !== null) {
        this.#reducer.step(event);
        this.#events += 1;
      }
      return;
    }

    const collector = this.#collector;
    if (collector === null) {
      this.#beforeFirstGame += 1;
      return;
    }

    this.#pending.push(raw);
    collector.push(raw);

    if (collector.resolved) {
      this.#open(collector.snapshot());
      return;
    }

    if (this.#pending.length > RESOLVE_LIMIT) {
      // Дамп без объявления своего игрока разобрать нечем. Молча копить
      // строки дальше — верный способ съесть память и не сказать почему.
      this.#collector = null;
      this.#pending = [];
      this.#abandoned += 1;
    }
  }

  #startGame(): void {
    this.#assembler = new PowerEventAssembler();
    this.#collector = new PlayersCollector();
    this.#pending = [];
    this.#reducer = null;
    this.#game = null;
    this.#games += 1;
    this.#events = 0;
  }

  #open(players: Players): void {
    this.#reducer = createReducer(players);
    this.#game = { id: this.#games, players };

    const buffered = this.#pending;
    this.#pending = [];
    this.#collector = null;

    for (const line of buffered) {
      const event = this.#assembler.push(line);
      if (event !== null) {
        this.#reducer.step(event);
        this.#events += 1;
      }
    }
  }

  /** Состояние текущей партии, или null пока «кто я» неизвестно. */
  snapshot(): GameState | null {
    return this.#reducer?.snapshot() ?? null;
  }

  /** Текущая партия, или null если ни одна ещё не открылась. */
  get game(): FeedGame | null {
    return this.#game;
  }

  /** Сколько раз встретился CREATE_GAME. */
  get gamesSeen(): number {
    return this.#games;
  }

  /** Сколько событий применено к состоянию текущей партии. */
  get events(): number {
    return this.#events;
  }

  /** Диагностика: строки до первого CREATE_GAME и брошенные дампы. */
  get diagnostics(): { beforeFirstGame: number; abandoned: number; buffered: number } {
    return {
      beforeFirstGame: this.#beforeFirstGame,
      abandoned: this.#abandoned,
      buffered: this.#pending.length,
    };
  }
}

function isCreateGame(raw: string): boolean {
  // Строка ровно `CREATE_GAME` без отступа. Проверка через разбор, а не
  // подстрокой: то же слово приходит и в канале PowerTaskList, который мы
  // не применяем, иначе теги применились бы дважды.
  const line = parseLogLine(raw);
  return line !== null && line.source === SOURCE_OF_TRUTH && line.content === 'CREATE_GAME';
}
