import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { readTavernTurns } from '../advisors/tavern/turns.js';
import { reduceLog } from '../state/reducer.js';
import { DATASET_DIR, type DatasetRecord } from './recorder.js';

/**
 * Разовый досбор датасета из фикстур: партии, сыгранные ДО включения
 * записи, не должны пропасть.
 *
 *   npm run dataset:backfill
 *
 * Берутся только партии текущего билда (part4+): пул карт и правила
 * старых билдов другие, и учиться на них — учиться другой игре.
 * part1–part3 остаются проверкой разбора лога, как и записано в CLAUDE.md.
 * Скрипт идемпотентен: существующие файлы не перезаписываются.
 */

const FIXTURES = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22] as const;

function main(): void {
  mkdirSync(DATASET_DIR, { recursive: true });
  let written = 0;

  for (const part of FIXTURES) {
    const path = `data/fixtures/part${String(part)}/game.log`;
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
    };

    const fileName = `backfill_part${String(part)}_b${String(record.buildNumber ?? 'unknown')}_p${String(record.finalPlace ?? 'x')}.json`;
    const target = join(DATASET_DIR, fileName);
    if (existsSync(target)) {
      console.log(`part${String(part)}: уже в датасете, пропущено`);
      continue;
    }

    writeFileSync(target, JSON.stringify(record), 'utf8');
    written += 1;
    console.log(
      `part${String(part)}: ${String(checkpoints.length)} точек решения, ` +
        `место ${String(record.finalPlace ?? '—')}, билд ${String(record.buildNumber ?? '—')} → ${fileName}`,
    );
  }

  console.log(`\nзаписано партий: ${String(written)}`);
}

main();
