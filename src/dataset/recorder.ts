import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { DATASET_DIR } from '../app/paths.js';
import type { GameState, PlayerAction } from '../state/types.js';

/**
 * Накопление датасета собственных партий — сырьё фазы 6 (ML).
 *
 * Фаза 6 по ТЗ начинается «после накопления датасета собственных партий»,
 * и копить его надо с первого дня: каждая сыгранная партия, не попавшая
 * в датасет, потеряна навсегда. Записывается ровно то, на чём будет
 * учиться предсказание места: точки решения каждого хода таверны
 * (то же определение, что у `readTavernTurns`, — последнее состояние
 * до первой траты золота) плюс финальное место.
 *
 * Запись — один JSON на партию в `data/dataset/` (в git не попадает,
 * см. .gitignore: это личные накопления, а не фикстуры). Пишется один раз,
 * на конце партии; партия без единой точки решения (подключились к самому
 * финалу) не пишется — учиться в ней не на чем.
 *
 * Честная оговорка: помощник, запущенный посреди партии, запишет только
 * ходы после запуска — поле `checkpoints` начинается с первого виденного.
 */

export interface DatasetCheckpoint {
  readonly turn: number;
  readonly state: GameState;
}

export interface DatasetRecord {
  /** Когда записано, ISO. Часы — приложения: в логе времени партии нет. */
  readonly savedAt: string;
  readonly buildNumber: number | null;
  readonly heroCardId: string | null;
  readonly finalPlace: number | null;
  readonly checkpoints: readonly DatasetCheckpoint[];
  /**
   * Журнал действий всей партии — из финального состояния (с 19.08).
   * У записей, сделанных раньше, поля нет; досбор дописывает его
   * из фикстур, а живой путь получает из `GameState.actions` сам.
   */
  readonly actions?: readonly PlayerAction[];
  /**
   * Чья партия, если не своя: псевдоним исполнителя, под которым архив
   * принят командой `dataset:import`. У собственных записей поля нет —
   * отсутствие и значит «своя», как у `actions` до 19.08.
   */
  readonly contributor?: string;
  /** Рейтинг исполнителя СО СЛОВ: в Power.log рейтинга нет (проверено part33). */
  readonly contributorRating?: number;
  /**
   * Шёл ли при этой партии оверлей с советами. Партия, сыгранная
   * по подсказкам, — не «как играют люди», а «как играют с советником»
   * (второй контур петли, docs/ml.md); без флага их не различить.
   */
  readonly overlay?: boolean;
}

/**
 * Отпечаток ПАРТИИ — чтобы одна и та же игра не попала в датасет дважды.
 *
 * Нужен он потому, что путей записи два: живой режим пишет партию на её
 * конце сам, а `dataset:backfill` досыпает партии из фикстур. Одна и та же
 * партия проходит обоими путями — фикстура это и есть лог той партии, —
 * и разойтись они могут только именем файла (время записи у них разное).
 * Досбор проверял ровно имя, поэтому пять партий (part17–part21) лежат
 * в датасете ДВАЖДЫ: и живой записью, и досбором. Для обучения это
 * не «чуть больше данных», а вес партии, удвоенный без причины.
 *
 * Из чего складывается отпечаток: билд, герой, финальное место и ПЕРВАЯ
 * точка решения — её ход и состав витрины. Билда с героем и местом мало:
 * в этом же датасете две партии одним героем и с одним местом уже есть.
 * Витрина первого хода — случайные пять карт, совпадения между разными
 * партиями практически исключены, а между двумя записями ОДНОЙ партии
 * она тождественна: живой и пакетный пути дают одно состояние, и это
 * отдельно закреплено тестом.
 *
 * Честная граница: помощник, запущенный ПОСРЕДИ партии, начинает точки
 * не с первого хода, и отпечаток у такой записи будет другим. Тогда
 * досбор добавит полную запись рядом с обрывочной — данных это не портит
 * (полная честнее), но одной партией датасет всё же посчитает две.
 *
 * 02.09.2026 эта граница встретилась в жизни, дважды, когда список партий
 * дошёл до part35, и случаи оказались РАЗНЫЕ:
 *
 *  - **part28** — оверлей включён посреди партии: живая запись держала
 *    ходы 3…17 (8 точек) против 1…17 у досбора (9) при том же журнале
 *    действий. Строгое подмножество, живая запись удалена;
 *  - **part35** — клиент перезапускался: живая запись держит 21,23,25,
 *    досборная — 1…19,23,25, и хода 21 нет НИ У ОДНОЙ. Склейка сегментов
 *    теряет точку шва (см. `readFixtureGame`), поэтому ни одна запись
 *    не покрывает другую, и пара оставлена как есть.
 *
 * Досбор теперь такие пары НАЗЫВАЕТ (`backfill.ts`): прежде предупреждение
 * молчало, если у лежащей записи есть `lobby`, — а у живых записей
 * 26–28.08 он есть. Что делать с парой, по-прежнему решает владелец
 * данных, а не скрипт; урок part35 в том, что «полная честнее» — правило,
 * а не закон, и проверять надо составом точек, а не их числом.
 */
export function gameSignature(record: DatasetRecord): string {
  const first = record.checkpoints[0];
  const shop =
    first === undefined
      ? ''
      : [...first.state.shop]
          .map((m) => m.cardId)
          .sort()
          .join(',');
  return [
    record.buildNumber ?? 'unknown',
    record.heroCardId ?? 'unknown',
    record.finalPlace ?? 'x',
    first?.turn ?? -1,
    shop,
  ].join('|');
}

export interface DatasetRecorderDeps {
  readonly dir: string;
  /** Подменяется в тестах; по умолчанию — файл на диске. */
  readonly save?: (fileName: string, record: DatasetRecord) => void;
  /** Подменяется в тестах: имя файла содержит время записи. */
  readonly now?: () => Date;
}

/** Имя файла партии: время, билд, место — читается глазами без открытия. */
function fileNameFor(record: DatasetRecord): string {
  const stamp = record.savedAt.replace(/[:.]/g, '-').slice(0, 19);
  const build = record.buildNumber === null ? 'unknown' : String(record.buildNumber);
  const place = record.finalPlace === null ? 'x' : String(record.finalPlace);
  return `${stamp}_b${build}_p${place}.json`;
}

function saveToDisk(dir: string): (fileName: string, record: DatasetRecord) => void {
  return (fileName, record) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), JSON.stringify(record), 'utf8');
  };
}

/** Точки решения из потока состояний — та же логика, что `readTavernTurns`. */
export class DecisionPoints {
  #pending: DatasetCheckpoint | null = null;
  #turns: DatasetCheckpoint[] = [];

  #commit(): void {
    if (this.#pending !== null && this.#pending.state.shop.length > 0) {
      this.#turns.push(this.#pending);
    }
    this.#pending = null;
  }

  update(state: GameState): void {
    if (state.phase !== 'tavern' || state.turn === 0 || state.hero === null) {
      this.#commit();
      return;
    }
    if (this.#pending !== null && this.#pending.turn !== state.turn) this.#commit();
    // Золото тронуто — решение уже принято, дальше состояние не наше.
    if (state.goldSpent > 0 || state.goldTotal === 0) return;
    this.#pending = { turn: state.turn, state };
  }

  drain(): readonly DatasetCheckpoint[] {
    this.#commit();
    const turns = this.#turns;
    this.#turns = [];
    return turns;
  }

  reset(): void {
    this.#pending = null;
    this.#turns = [];
  }
}

export class DatasetRecorder {
  readonly #save: (fileName: string, record: DatasetRecord) => void;
  readonly #now: () => Date;
  readonly #points = new DecisionPoints();
  #written = false;

  constructor(deps: DatasetRecorderDeps) {
    this.#save = deps.save ?? saveToDisk(deps.dir);
    this.#now = deps.now ?? ((): Date => new Date());
  }

  /** Новая партия: прошлые точки — прошлой партии. */
  reset(): void {
    this.#points.reset();
    this.#written = false;
  }

  update(state: GameState): void {
    this.#points.update(state);

    if (state.phase !== 'gameOver' || this.#written) return;
    this.#written = true;

    const checkpoints = this.#points.drain();
    // Партия без единой точки решения — подключение к самому финалу:
    // учиться не на чем, файл был бы мусором.
    if (checkpoints.length === 0) return;

    const record: DatasetRecord = {
      savedAt: this.#now().toISOString(),
      buildNumber: state.buildNumber,
      heroCardId: state.hero?.cardId ?? null,
      finalPlace: state.finalPlace,
      checkpoints,
      actions: state.actions,
    };
    this.#save(fileNameFor(record), record);
  }
}

/**
 * Каталог датасета по умолчанию: из репозитория — `data/dataset` рядом
 * с фикстурами, вне git; из сборки — в профиле пользователя (`app/paths.ts`).
 */
export { DATASET_DIR };
