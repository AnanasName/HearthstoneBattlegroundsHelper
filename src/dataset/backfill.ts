import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readTavernTurns } from '../advisors/tavern/turns.js';
import { CURRENT_BUILD_PARTS, fixtureLogPaths, readFixtureGame } from '../data/fixtureGames.js';
import { firstPointKey, fixturePartOf, recordKey } from '../ml/dataset.js';
import { reduceLog } from '../state/reducer.js';
import { DATASET_DIR, gameSignature, type DatasetRecord } from './recorder.js';
import { refreshRecord } from './refresh.js';

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
  record: DatasetRecord;
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

  // Задвоенное уже лежащим датасетом называется вслух: чистить его —
  // решение владельца данных, а не скрипта.
  for (const [, files] of existing) {
    if (files.length > 1) {
      console.log(
        `ВНИМАНИЕ: одна партия записана дважды — ${files.map((f) => f.fileName).join(', ')}`,
      );
    }
  }

  // Сначала — свежий разбор всех фикстур: ключи первых точек нужны все
  // сразу, чтобы ключ, общий для двух партий, не приписал запись чужой.
  // Свежие записи ждут второго прохода во временных файлах: все партии
  // сразу в памяти — это 4 ГБ на 52 партиях (замер 19.09).
  const staging = mkdtempSync(join(tmpdir(), 'hsbg-backfill-'));
  try {
    backfill([...existing.values()].flat(), staging, force);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function backfill(all: readonly ExistingRecord[], staging: string, force: boolean): void {
  const fresh: { part: number; path: string; keys: string[] }[] = [];
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
      fixturePart: part,
    };
    const path = join(staging, `part${String(part)}.json`);
    writeFileSync(path, JSON.stringify(record), 'utf8');
    fresh.push({ part, path, keys: firstPointKeys(part, record) });
  }

  const partsByKey = new Map<string, Set<number>>();
  for (const { part, keys } of fresh) {
    for (const key of keys) partsByKey.set(key, (partsByKey.get(key) ?? new Set()).add(part));
  }
  // Ключ, общий для двух партий, не сопоставляет ни одну из них.
  const partByKey = new Map<string, number>();
  for (const [key, parts] of partsByKey) {
    const [only] = parts;
    if (parts.size === 1 && only !== undefined) partByKey.set(key, only);
  }

  let written = 0;
  let patched = 0;
  let rebuilt = 0;
  for (const { part, path } of fresh) {
    const record = JSON.parse(readFileSync(path, 'utf8')) as DatasetRecord;
    const signature = gameSignature(record);
    // Та же партия, найденная любым из путей: номер (поле или имя файла
    // досбора), отпечаток — или первая точка партии либо её сегмента
    // у записи, которой номер ещё не назначен. Последний путь и ловит
    // записи, которые отпечаток пропускал: старый герой (part10, part46),
    // старое место (part31, part44), обрывок после перезапуска (part35,
    // part41 — первая точка обрывка совпадает с первой точкой сегмента).
    const already = all.filter((file) => {
      const known = fixturePartOf(file);
      if (known !== null) return known === part;
      return gameSignature(file.record) === signature || partByKey.get(recordKey(file.record)) === part;
    });

    if (already.length > 0) {
      // Что делать с найденной записью, решает `refreshRecord`: запись
      // без номера фикстуры пересобирается из лога целиком (с героем
      // и местом), запись старой схемы — точками и журналом, запись
      // текущей схемы без журнала получает журнал; паспорт записи (время,
      // исполнитель, флаг оверлея) остаётся всегда.
      for (const file of already) {
        const plan = refreshRecord(file.record, record, force);
        if (plan.action === 'keep') continue;
        writeFileSync(join(DATASET_DIR, file.fileName), JSON.stringify(plan.record), 'utf8');
        const before = file.record;
        file.record = plan.record;
        if (plan.action === 'rebuild') {
          rebuilt += 1;
          const relabel =
            before.heroCardId !== record.heroCardId || before.finalPlace !== record.finalPlace
              ? `, герой/место ${String(before.heroCardId)}/${String(before.finalPlace)} → ` +
                `${String(record.heroCardId)}/${String(record.finalPlace)}`
              : '';
          console.log(
            `part${String(part)}: пересобрана запись — точек ${String(before.checkpoints.length)} → ` +
              `${String(record.checkpoints.length)}${relabel} → ${file.fileName}`,
          );
        } else {
          patched += 1;
          console.log(
            `part${String(part)}: дописаны действия (${String(record.actions?.length ?? 0)}) → ${file.fileName}`,
          );
        }
      }
      if (already.length > 1) {
        console.log(
          `part${String(part)}: записей партии ${String(already.length)} — загрузчик оставит одну ` +
            `(${already.map((f) => f.fileName).join(', ')})`,
        );
      }
      continue;
    }

    const fileName = `backfill_part${String(part)}_b${String(record.buildNumber ?? 'unknown')}_p${String(record.finalPlace ?? 'x')}.json`;
    writeFileSync(join(DATASET_DIR, fileName), JSON.stringify(record), 'utf8');
    written += 1;
    console.log(
      `part${String(part)}: ${String(record.checkpoints.length)} точек решения, ` +
        `место ${String(record.finalPlace ?? '—')}, билд ${String(record.buildNumber ?? '—')} → ${fileName}`,
    );
  }

  const ambiguous = [...partsByKey].filter(([, parts]) => parts.size > 1);
  for (const [key, parts] of ambiguous) {
    console.log(`ВНИМАНИЕ: первая точка ${key} общая у партий ${[...parts].join(', ')} — по ней не сопоставляется`);
  }
  console.log(
    `\nзаписано партий: ${String(written)}, пересобрано записей: ${String(rebuilt)}, ` +
      `дописано действий в записей: ${String(patched)}`,
  );
}

/**
 * Ключи первых точек партии: всей партии и каждого сегмента. Живая запись,
 * начатая после перезапуска клиента, начинается с первой точки сегмента,
 * а не партии (part35: ход 21, part41: ход 25).
 */
function firstPointKeys(part: number, record: DatasetRecord): string[] {
  const keys = [recordKey(record)];
  for (const path of fixtureLogPaths(part).slice(1)) {
    const first = readTavernTurns(readFileSync(path, 'utf8'))[0];
    if (first !== undefined) keys.push(firstPointKey(record.buildNumber, first));
  }
  return keys;
}

main();
