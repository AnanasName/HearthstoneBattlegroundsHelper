import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTavernTurns } from '../advisors/tavern/turns.js';
import { CURRENT_BUILD_PARTS, fixtureLogPath } from '../data/fixtureGames.js';
import { reduceLog } from '../state/reducer.js';
import { DATASET_DIR, gameSignature, type DatasetRecord } from './recorder.js';

/**
 * Разовый досбор датасета из фикстур: партии, сыгранные ДО включения
 * записи, не должны пропасть.
 *
 *   npm run dataset:backfill
 *
 * Берутся только партии текущего билда: пул карт и правила старых билдов
 * другие, и учиться на них — учиться другой игре. Список — общий
 * (`CURRENT_BUILD_PARTS`), потому что своя копия у каждого скрипта уже
 * разъезжалась. part1–part3 в него не входят, как записано в CLAUDE.md.
 *
 * Идемпотентность — ПО СОДЕРЖАНИЮ, а не по имени файла. Прежняя проверка
 * («файла `backfill_partN_…` нет») ловила только повторный запуск самого
 * досбора и ничего не знала про ЖИВУЮ запись, которая называет файл
 * временем. Партия, сыгранная с оверлеем и потом положенная в фикстуры,
 * попадала в датасет дважды — так в нём и оказались part17–part21 —
 * а обучению это даёт партию с удвоенным весом. Отпечаток партии считает
 * `gameSignature`.
 */

const FIXTURES = CURRENT_BUILD_PARTS;

interface ExistingRecord {
  readonly fileName: string;
  readonly record: DatasetRecord;
}

/** Отпечатки партий, которые в датасете уже лежат, — любым путём записи. */
function existingSignatures(): Map<string, ExistingRecord[]> {
  const bySignature = new Map<string, ExistingRecord[]>();
  if (!existsSync(DATASET_DIR)) return bySignature;

  for (const fileName of readdirSync(DATASET_DIR)) {
    if (!fileName.endsWith('.json')) continue;
    let record: DatasetRecord;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(DATASET_DIR, fileName), 'utf8'));
      // Чужой JSON в каталоге (снапшот статистики карт) — не запись партии.
      // Проверка стоит ВНУТРИ try: у файла с содержимым `null` разбор
      // проходит, а чтение поля роняет весь досбор.
      if (typeof parsed !== 'object' || parsed === null) continue;
      if (!Array.isArray((parsed as { checkpoints?: unknown }).checkpoints)) continue;
      record = parsed as DatasetRecord;
    } catch {
      continue;
    }

    const signature = gameSignature(record);
    const seen = bySignature.get(signature);
    if (seen === undefined) bySignature.set(signature, [{ fileName, record }]);
    else seen.push({ fileName, record });
  }
  return bySignature;
}

function main(): void {
  mkdirSync(DATASET_DIR, { recursive: true });
  const existing = existingSignatures();
  let written = 0;

  // Задвоенное уже лежащим датасетом называется вслух: чистить его —
  // решение владельца данных, а не скрипта.
  for (const [, files] of existing) {
    if (files.length > 1) {
      console.log(
        `ВНИМАНИЕ: одна партия записана дважды — ${files.map((f) => f.fileName).join(', ')}`,
      );
    }
  }

  let patched = 0;
  for (const part of FIXTURES) {
    const path = fixtureLogPath(part);
    if (!existsSync(path)) {
      console.log(`part${String(part)}: лога нет, пропущено`);
      continue;
    }

    const text = readFileSync(path, 'utf8');
    const finalState = reduceLog(text);
    const checkpoints = readTavernTurns(text);
    if (checkpoints.length === 0) {
      console.log(`part${String(part)}: ни одной точки решения, пропущено`);
      continue;
    }

    const record: DatasetRecord = {
      savedAt: new Date().toISOString(),
      buildNumber: finalState.buildNumber,
      heroCardId: finalState.hero?.cardId ?? null,
      finalPlace: finalState.finalPlace,
      checkpoints,
      actions: finalState.actions,
    };

    const already = existing.get(gameSignature(record));
    if (already !== undefined) {
      // Партия уже в датасете. Единственное, что досбор в ней ДОПИСЫВАЕТ, —
      // журнал действий: записи до 19.08 его не несут, а без действий
      // «какие ходы ведут к победе» не выучить. Ничего не перетирается:
      // поле добавляется только там, где его не было.
      for (const { fileName, record: stored } of already) {
        if (stored.actions !== undefined) continue;
        writeFileSync(
          join(DATASET_DIR, fileName),
          JSON.stringify({ ...stored, actions: finalState.actions }),
          'utf8',
        );
        patched += 1;
        console.log(
          `part${String(part)}: дописаны действия (${String(finalState.actions.length)}) → ${fileName}`,
        );
      }
      continue;
    }

    const fileName = `backfill_part${String(part)}_b${String(record.buildNumber ?? 'unknown')}_p${String(record.finalPlace ?? 'x')}.json`;
    writeFileSync(join(DATASET_DIR, fileName), JSON.stringify(record), 'utf8');
    existing.set(gameSignature(record), [{ fileName, record }]);
    written += 1;
    console.log(
      `part${String(part)}: ${String(checkpoints.length)} точек решения, ` +
        `место ${String(record.finalPlace ?? '—')}, билд ${String(record.buildNumber ?? '—')} → ${fileName}`,
    );
  }

  console.log(`\nзаписано партий: ${String(written)}, дописано действий в записей: ${String(patched)}`);
}

main();
