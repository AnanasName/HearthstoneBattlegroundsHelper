import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GameState } from '../state/types.js';

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
    };
    this.#save(fileNameFor(record), record);
  }
}

/** Каталог датасета по умолчанию — рядом с фикстурами, но вне git. */
export const DATASET_DIR = 'data/dataset';
