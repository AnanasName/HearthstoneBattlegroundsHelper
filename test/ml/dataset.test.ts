import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { CARDS_PATH, createCardIndex } from '../../src/data/cards.js';
import { dedupeBySignature, upgradeRecord, type RecordFile } from '../../src/ml/dataset.js';
import type { DatasetRecord } from '../../src/dataset/recorder.js';
import { EMPTY_STATE, type GameState, type Hero } from '../../src/state/types.js';
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

/**
 * Запись — снимок GameState на момент записи, и поля, вошедшие в состояние
 * позже, в ней отсутствуют. На 28.08 heroPowerScriptData (part34) было
 * у ОДНОЙ записи из 38, и hero.heroPowerScriptData[0] ронял
 * npm run ml:track с TypeError. Старая запись здесь строится ВЫЧИТАНИЕМ
 * поздних полей из текущей схемы — ровно так они и отсутствуют в JSON.
 */
describe('дополнение старой записи до текущей схемы', () => {
  const LATE_STATE_KEYS = new Set(['rerollCost', 'lobby', 'actions', 'darkGiftCharges']);
  // Бранн-укротитель (part34): единственная сила, чей разбор индексирует
  // heroPowerScriptData без проверки — ровно та, что падала.
  const HERO: Hero = {
    entityId: 64,
    cardId: 'TB_BaconShop_HERO_43_SKIN_G',
    health: 30,
    damage: 0,
    armor: 0,
    heroPowerCardId: 'TB_BaconShop_HP_048',
    heroPowerEntityId: 65,
    heroPowerCost: null,
    heroPowerUsedThisTurn: false,
    heroPowerUnplayable: false,
    heroPowerLocked: false,
    heroPowerHasActivate: false,
    heroPowerScriptData: [],
  };

  function legacyState(): GameState {
    const hero = Object.fromEntries(
      Object.entries(HERO).filter(([k]) => k !== 'heroPowerScriptData'),
    );
    // Миньоны старой записи — без живой цены покупки (`buyCost`, part35).
    const legacyShop = board([201, 202]).map((m) =>
      Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'buyCost')),
    );
    const fresh: GameState = { ...EMPTY_STATE, turn: 1, gold: 3, goldTotal: 3 };
    const state = Object.fromEntries(
      Object.entries(fresh).filter(([k]) => !LATE_STATE_KEYS.has(k)),
    );
    // Старая запись по типу — не GameState: у неё нет обязательных полей.
    return { ...state, shop: legacyShop, hero } as unknown as GameState;
  }

  function recordWith(state: GameState): RecordFile['record'] {
    return { ...recordOf('legacy.json').record, checkpoints: [{ turn: 1, state }] };
  }

  it('поля, вошедшие в состояние позже, получают умолчания пустого состояния', () => {
    const state = upgradeRecord(recordWith(legacyState())).checkpoints[0]?.state;
    expect(state?.hero?.heroPowerScriptData).toEqual([]);
    expect(state?.rerollCost).toBeNull();
    expect(state?.lobby).toEqual({});
    expect(state?.actions).toEqual([]);
    expect(state?.darkGiftCharges).toBeNull();
    // Миньоны без живой цены покупки получают «кнопки не видно» (part35),
    // а не `undefined`, который `buyCostOf` превратил бы в NaN.
    expect(state?.shop).toHaveLength(2);
    expect(state?.shop.every((m) => m.buyCost === null)).toBe(true);
    // Альтернативная таверна (05.09): у записей до неё поля нет вовсе,
    // и умолчание — «не идёт». Ошибиться оно может только в сторону
    // прежнего поведения, с которым записи и собирались.
    expect(state?.altTavern).toBe(false);
    // Остальное — как было: дополнение не переписывает записанное.
    expect(state?.gold).toBe(3);
    expect(state?.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_048');
  });

  it('советник на старой записи за Бранна-укротителя не падает — а без дополнения падает', () => {
    const raw = JSON.parse(readFileSync(CARDS_PATH, 'utf8')) as unknown[];
    const cards = createCardIndex(raw);
    expect(() => adviseTavern(legacyState(), { cards })).toThrow(TypeError);
    const upgraded = upgradeRecord(recordWith(legacyState())).checkpoints[0]?.state;
    expect(upgraded).toBeDefined();
    expect(() => adviseTavern(upgraded as GameState, { cards })).not.toThrow();
  });

  it('запись текущей схемы дополнение не меняет', () => {
    const record = recordWith({ ...EMPTY_STATE, hero: HERO, shop: board([201]) });
    expect(upgradeRecord(record)).toEqual(record);
  });
});
