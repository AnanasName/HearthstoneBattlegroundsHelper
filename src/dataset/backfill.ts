import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTavernTurns } from '../advisors/tavern/turns.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../data/fixtureGames.js';
import { reduceLog } from '../state/reducer.js';
import { DATASET_DIR, gameSignature, type DatasetRecord } from './recorder.js';
import { lobbyKnown, refreshRecord } from './refresh.js';

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
 *
 * Досбор — ещё и способ дотянуть лежащие записи до текущей схемы состояния
 * из самого лога, а не из умолчаний: запись без таблицы лобби (до part26)
 * пересобирается целиком, запись без журнала действий (до 19.08) получает
 * журнал. Что и почему — в `refresh.ts`.
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
  // `--rebuild` — пересобрать точки и журнал у ВСЕХ лежащих записей фикстур,
  // а не только у записей старой схемы: нужно, когда меняется определение
  // точки решения (см. `refreshRecord`). Записи исполнителей (`c-*`)
  // и свои с установленного приложения (`own_*`) фикстур не имеют —
  // их пересобирает повторный `dataset:import` после удаления старых.
  const force = process.argv.includes('--rebuild');
  if (force) console.log('режим --rebuild: точки и журнал всех записей фикстур пересобираются');

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
  let rebuilt = 0;
  for (const part of FIXTURES) {
    const text = readFixtureGame(part);
    if (text === null) {
      console.log(`part${String(part)}: лога нет, пропущено`);
      continue;
    }

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
      // Партия уже в датасете. Что с ней делать, решает `refreshRecord`:
      // запись старой схемы (без таблицы лобби) пересобирается целиком —
      // точки и журнал берутся из сегодняшнего разбора, паспорт записи
      // (время, исполнитель, флаг оверлея) остаётся; запись текущей схемы
      // без журнала получает только журнал; остальное не трогается.
      for (const { fileName, record: stored } of already) {
        const plan = refreshRecord(stored, record, force);
        if (plan.action === 'keep') continue;
        writeFileSync(join(DATASET_DIR, fileName), JSON.stringify(plan.record), 'utf8');
        if (plan.action === 'rebuild') {
          rebuilt += 1;
          console.log(
            `part${String(part)}: пересобрана запись${force ? '' : ' старой схемы'} — точек ` +
              `${String(stored.checkpoints.length)} → ${String(checkpoints.length)}, ` +
              `таблица лобби во всех точках, действий ${String(finalState.actions.length)} → ${fileName}`,
          );
        } else {
          patched += 1;
          console.log(
            `part${String(part)}: дописаны действия (${String(finalState.actions.length)}) → ${fileName}`,
          );
        }
      }
      continue;
    }

    // Отпечаток не нашёлся, а партия того же билда, героя и места лежит:
    // досбор сейчас положит вторую запись рядом, и дедуп загрузчика такую
    // пару не сведёт. Причин у расхождения отпечатка ДВЕ, и вторая нашлась
    // 02.09, когда список дошёл до part35:
    //
    //  - редьюсер сдвинул ПЕРВУЮ точку решения (запись старой схемы);
    //  - живая запись НЕПОЛНАЯ — оверлей включили посреди партии (part28:
    //    первая точка на ходу 3 вместо 1) или клиент перезапускался и живой
    //    путь начал с реконнекта (part35: три точки с хода 21 из двенадцати).
    //
    // Прежде проверка молчала во втором случае: она пропускала записи,
    // у которых `lobby` уже есть, — а у живых записей 26–28.08 он есть.
    // Условие снято: это ПРЕДУПРЕЖДЕНИЕ, а не действие, и цена ложного
    // срабатывания (совпали билд, герой и место у разных партий) — одна
    // строка в отчёте против молча задвоенной партии в обучении.
    const passport = `${String(record.buildNumber)}|${String(record.heroCardId)}|${String(record.finalPlace)}|`;
    for (const [signature, files] of existing) {
      if (!signature.startsWith(passport)) continue;
      for (const { fileName, record: stored } of files) {
        const why = lobbyKnown(stored)
          ? `в лежащей записи ${String(stored.checkpoints.length)} точек против ` +
            `${String(checkpoints.length)} здесь — похоже на неполную живую запись`
          : 'запись старой схемы';
        console.log(
          `ВНИМАНИЕ: part${String(part)} не нашлась по отпечатку, а партия того же ` +
            `билда, героя и места лежит — ${fileName} (${why}); проверьте первую точку решения`,
        );
      }
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

  console.log(
    `\nзаписано партий: ${String(written)}, пересобрано записей${force ? '' : ' старой схемы'}: ${String(rebuilt)}, ` +
      `дописано действий в записей: ${String(patched)}`,
  );
}

main();
