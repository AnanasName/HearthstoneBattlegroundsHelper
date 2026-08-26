import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { sameGameBuild } from '../data/builds.js';
import { DATASET_DIR, gameSignature, type DatasetRecord } from '../dataset/recorder.js';

/**
 * Загрузка датасета партий для фазы 6 — с дедупом и фильтром билда.
 *
 * Дедуп обязателен: путей записи два (живой режим и досбор), и одна партия
 * может лежать двумя файлами — part17–part21 так и лежали. Для обучения
 * это не «чуть больше данных», а партия с удвоенным весом. Отпечаток
 * партии — `gameSignature`, тот же, что у досбора.
 *
 * Фильтр билда обязателен по той же причине, что у `CURRENT_BUILD_PARTS`:
 * учиться на партиях старого ПАТЧА — учиться другой игре (замерено
 * на калибровке: 3.9 → 9.0 п.п. без единой правки кода). Точка отсчёта —
 * новейший билд среди записей: датасет живёт дольше любого патча,
 * и жёсткое число здесь разъехалось бы с реальностью молча.
 *
 * Но отбор идёт не по РАВЕНСТВУ номера, а по таблице совместимости
 * (`src/data/builds.ts`): баланс и багфиксы меняют номер билда, оставляя
 * пул карт и правила прежними, и терять из-за них весь накопленный
 * датасет — формальность. Контентный патч в группу не попадает, и тогда
 * накопление честно начинается заново.
 */

export interface RecordFile {
  readonly fileName: string;
  readonly record: DatasetRecord;
}

/** Партия после отбора: место и точки гарантированно есть. */
export interface DatasetGame {
  readonly fileName: string;
  readonly finalPlace: number;
  readonly record: DatasetRecord;
}

export interface DedupeResult {
  readonly kept: readonly RecordFile[];
  /** Каждая группа задвоения: что оставлено и что отброшено. */
  readonly duplicates: readonly { readonly kept: string; readonly dropped: readonly string[] }[];
}

/**
 * Из группы записей одной партии остаётся ЗАПИСЬ С БОЛЬШИМ ЧИСЛОМ ТОЧЕК:
 * помощник, запущенный посреди партии, пишет обрывок, а досбор из фикстуры —
 * партию целиком, и полная запись честнее. При равенстве (живой и пакетный
 * пути дают одно состояние, обычно точек поровну) — лексикографически
 * первое имя файла, чтобы выбор был детерминирован.
 */
export function dedupeBySignature(files: readonly RecordFile[]): DedupeResult {
  const groups = new Map<string, RecordFile[]>();
  for (const file of [...files].sort((a, b) => a.fileName.localeCompare(b.fileName))) {
    const signature = gameSignature(file.record);
    const group = groups.get(signature);
    if (group === undefined) groups.set(signature, [file]);
    else group.push(file);
  }

  const kept: RecordFile[] = [];
  const duplicates: { kept: string; dropped: string[] }[] = [];
  for (const [, group] of groups) {
    const best = group.reduce((a, b) =>
      b.record.checkpoints.length > a.record.checkpoints.length ? b : a,
    );
    kept.push(best);
    const dropped = group.filter((f) => f !== best).map((f) => f.fileName);
    if (dropped.length > 0) duplicates.push({ kept: best.fileName, dropped });
  }
  kept.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { kept, duplicates };
}

export interface LoadedDataset {
  /** Партии после дедупа, фильтра билда и отбора записей. */
  readonly games: readonly DatasetGame[];
  /** Новейший билд среди записей — только он и учится. */
  readonly build: number | null;
  /**
   * Сколько записей какого билда лежит в датасете, по убыванию билда.
   *
   * Нужно, чтобы смена патча не выглядела поломкой: в день выхода патча
   * новая партия остаётся в выборке одна, а два десятка прежних честно
   * отбрасываются фильтром билда — и об этом надо говорить числом,
   * а не молчанием. Поле `learned` отвечает, вошёл ли билд в выборку:
   * билды одной группы совместимости учатся вместе (`src/data/builds.ts`).
   */
  readonly recordsByBuild: readonly {
    readonly build: number | null;
    readonly records: number;
    readonly learned: boolean;
  }[];
  readonly duplicates: DedupeResult['duplicates'];
  /** Записи чужого (не новейшего) билда — вслух, не молча. */
  readonly droppedOtherBuild: readonly string[];
  /** Записи без финального места или без точек — учиться не на чем. */
  readonly droppedUnusable: readonly string[];
}

/** Запись ли это партии: в каталоге лежат и чужие JSON (снапшот статистики). */
function isDatasetRecord(value: unknown): value is DatasetRecord {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { checkpoints?: unknown }).checkpoints)
  );
}

export function loadDataset(dir: string = DATASET_DIR): LoadedDataset {
  const files: RecordFile[] = [];
  if (existsSync(dir)) {
    for (const fileName of readdirSync(dir)) {
      if (!fileName.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(join(dir, fileName), 'utf8'));
      } catch {
        continue;
      }
      if (!isDatasetRecord(parsed)) continue;
      files.push({ fileName, record: parsed });
    }
  }

  const build = files.reduce<number | null>((max, f) => {
    const b = f.record.buildNumber;
    return b !== null && (max === null || b > max) ? b : max;
  }, null);

  const counts = new Map<number | null, number>();
  for (const f of files) {
    counts.set(f.record.buildNumber, (counts.get(f.record.buildNumber) ?? 0) + 1);
  }
  const recordsByBuild = [...counts.entries()]
    .map(([b, records]) => ({ build: b, records, learned: sameGameBuild(b, build) }))
    .sort((a, b) => (b.build ?? -1) - (a.build ?? -1));

  // Отбор идёт не по равенству билда, а по таблице совместимости
  // (`src/data/builds.ts`): баланс и багфиксы меняют номер билда, но игру
  // оставляют прежней, и терять из-за них накопленное — формальность.
  const currentBuild = files.filter((f) => sameGameBuild(f.record.buildNumber, build));
  const droppedOtherBuild = files
    .filter((f) => !sameGameBuild(f.record.buildNumber, build))
    .map((f) => f.fileName);

  const { kept, duplicates } = dedupeBySignature(currentBuild);

  const games: DatasetGame[] = [];
  const droppedUnusable: string[] = [];
  for (const file of kept) {
    const place = file.record.finalPlace;
    if (place === null || file.record.checkpoints.length === 0) {
      droppedUnusable.push(file.fileName);
      continue;
    }
    games.push({ fileName: file.fileName, finalPlace: place, record: file.record });
  }

  return { games, build, recordsByBuild, duplicates, droppedOtherBuild, droppedUnusable };
}
