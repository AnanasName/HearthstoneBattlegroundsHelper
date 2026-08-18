import { describe, expect, it } from 'vitest';

import { dedupeBySignature, type RecordFile } from '../../src/ml/dataset.js';
import type { DatasetRecord } from '../../src/dataset/recorder.js';
import { EMPTY_STATE } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Дедуп датасета по отпечатку партии. part17–part21 реально лежали
 * в `data/dataset/` дважды — живой записью и досбором, — и без дедупа
 * обучение получало партию с удвоенным весом молча.
 */

function recordOf(
  fileName: string,
  opts: {
    readonly place?: number;
    readonly shopIds?: readonly number[];
    readonly checkpointTurns?: readonly number[];
  } = {},
): RecordFile {
  const shopIds = opts.shopIds ?? [201, 202, 203];
  const turns = opts.checkpointTurns ?? [1, 3, 5];
  const record: DatasetRecord = {
    savedAt: '2026-08-18T00:00:00.000Z',
    buildNumber: 248348,
    heroCardId: 'BG33_HERO_001',
    finalPlace: opts.place ?? 4,
    checkpoints: turns.map((turn) => ({
      turn,
      state: { ...EMPTY_STATE, turn, shop: board(shopIds) },
    })),
  };
  return { fileName, record };
}

describe('дедуп датасета по отпечатку', () => {
  it('одна партия двумя файлами: остаётся запись с большим числом точек', () => {
    const short = recordOf('2026-08-15T13-21-57_b248348_p4.json', {
      checkpointTurns: [3, 5],
    });
    const full = recordOf('backfill_part17_b248348_p4.json', {
      checkpointTurns: [3, 5, 7, 9],
    });
    // Отпечаток совпадает: первая точка и её витрина у обоих одинаковы.
    const result = dedupeBySignature([short, full]);
    expect(result.kept.map((f) => f.fileName)).toEqual(['backfill_part17_b248348_p4.json']);
    expect(result.duplicates).toEqual([
      {
        kept: 'backfill_part17_b248348_p4.json',
        dropped: ['2026-08-15T13-21-57_b248348_p4.json'],
      },
    ]);
  });

  it('при равном числе точек выбор детерминирован — лексикографически первое имя', () => {
    const a = recordOf('backfill_part18_b248348_p4.json');
    const b = recordOf('2026-08-16T19-11-09_b248348_p4.json');
    const result = dedupeBySignature([a, b]);
    expect(result.kept.map((f) => f.fileName)).toEqual(['2026-08-16T19-11-09_b248348_p4.json']);
    // И порядок входа не влияет.
    const reversed = dedupeBySignature([b, a]);
    expect(reversed.kept.map((f) => f.fileName)).toEqual(['2026-08-16T19-11-09_b248348_p4.json']);
  });

  it('разные партии не склеиваются: витрина первого хода различает их', () => {
    const one = recordOf('a.json', { shopIds: [201, 202, 203] });
    const other = recordOf('b.json', { shopIds: [301, 302, 303] });
    const result = dedupeBySignature([one, other]);
    expect(result.kept).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });
});
