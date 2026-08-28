import { describe, expect, it } from 'vitest';

import { DatasetRecorder, gameSignature, type DatasetRecord } from '../../src/dataset/recorder.js';
import { EMPTY_STATE, type GameState, type Hero } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Накопитель датасета: точки решения по потоку состояний и запись
 * на конце партии. Определение точки решения — то же, что
 * у `readTavernTurns`: последнее состояние до первой траты золота.
 */

const HERO: Hero = {
  entityId: 64,
  cardId: 'BG33_HERO_001',
  health: 30,
  damage: 0,
  armor: 0,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
  heroPowerHasActivate: false,
  heroPowerScriptData: [],
};

function tavern(turn: number, patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    hero: HERO,
    gold: 5,
    goldTotal: 5,
    goldSpent: 0,
    buildNumber: 248348,
    shop: board([200 + turn]),
    ...patch,
  };
}

function recorderWithSink(): { recorder: DatasetRecorder; saved: DatasetRecord[]; names: string[] } {
  const saved: DatasetRecord[] = [];
  const names: string[] = [];
  const recorder = new DatasetRecorder({
    dir: 'unused',
    save: (name, record) => {
      names.push(name);
      saved.push(record);
    },
    now: () => new Date('2026-08-15T02:00:00Z'),
  });
  return { recorder, saved, names };
}

describe('накопитель датасета', () => {
  it('пишет партию один раз: точки решения, герой, билд, место', () => {
    const { recorder, saved, names } = recorderWithSink();

    // Ход 1: снимок до траты, потом трата — точка решения зафиксирована.
    recorder.update(tavern(1, { gold: 3, goldTotal: 3 }));
    recorder.update(tavern(1, { gold: 0, goldTotal: 3, goldSpent: 3 }));
    // Бой между ходами.
    recorder.update({ ...tavern(2), phase: 'combat' });
    // Ход 3: два снимка до траты — берётся последний.
    recorder.update(tavern(3, { gold: 4, goldTotal: 4 }));
    recorder.update(tavern(3, { gold: 4, goldTotal: 4, shop: board([301, 302]) }));

    const over: GameState = { ...tavern(3), phase: 'gameOver', finalPlace: 4 };
    recorder.update(over);
    recorder.update(over);

    expect(saved).toHaveLength(1);
    const record = saved[0];
    expect(record?.finalPlace).toBe(4);
    expect(record?.heroCardId).toBe('BG33_HERO_001');
    expect(record?.buildNumber).toBe(248348);
    expect(record?.checkpoints.map((c) => c.turn)).toEqual([1, 3]);
    // Точка решения — ПОСЛЕДНЕЕ состояние до траты: витрина полная.
    expect(record?.checkpoints[1]?.state.shop).toHaveLength(2);
    // Имя файла читается глазами: время, билд, место.
    expect(names[0]).toBe('2026-08-15T02-00-00_b248348_p4.json');
  });

  it('партия без единой точки решения не пишется', () => {
    const { recorder, saved } = recorderWithSink();
    recorder.update({ ...tavern(21), phase: 'gameOver', finalPlace: 7 });
    expect(saved).toHaveLength(0);
  });

  it('сброс на новой партии не тянет чужие точки', () => {
    const { recorder, saved } = recorderWithSink();
    recorder.update(tavern(1));
    recorder.reset();

    recorder.update(tavern(1, { shop: board([900]) }));
    recorder.update({ ...tavern(1), phase: 'gameOver', finalPlace: 1 });

    expect(saved).toHaveLength(1);
    expect(saved[0]?.checkpoints).toHaveLength(1);
    expect(saved[0]?.checkpoints[0]?.state.shop[0]?.entityId).toBe(900);
  });

  it('журнал действий из финального состояния попадает в запись', () => {
    const { recorder, saved } = recorderWithSink();
    const actions = [
      { turn: 1, type: 'buy', cardId: 'BGS_119', entityId: 329 },
      { turn: 1, type: 'play', cardId: 'BGS_119', entityId: 329 },
    ] as const;

    recorder.update(tavern(1, { gold: 3, goldTotal: 3 }));
    recorder.update({ ...tavern(1), phase: 'gameOver', finalPlace: 2, actions });

    expect(saved[0]?.actions).toEqual(actions);
  });
});

describe('отпечаток партии', () => {
  /**
   * Одна и та же партия попадает в датасет двумя путями: живой режим пишет
   * её на конце сам, а `dataset:backfill` досыпает её из фикстуры. Имена
   * файлов у них разные (время против номера партии), и проверка «такого
   * файла ещё нет» их не сводила — так в датасете и оказались пять партий
   * по два раза. Отпечаток сводит записи по СОДЕРЖАНИЮ.
   */
  const record = (patch: Partial<DatasetRecord> = {}): DatasetRecord => ({
    savedAt: '2026-08-17T20:15:27.000Z',
    buildNumber: 248348,
    heroCardId: 'BG34_HERO_000',
    finalPlace: 3,
    checkpoints: [{ turn: 1, state: tavern(1) }],
    ...patch,
  });

  it('время записи в отпечаток не входит: два пути — одна партия', () => {
    const live = record({ savedAt: '2026-08-17T20:15:27.000Z' });
    const backfilled = record({ savedAt: '2026-08-18T09:00:00.000Z' });
    expect(gameSignature(live)).toBe(gameSignature(backfilled));
  });

  it('герой, место и билд партию не различают — различает витрина первого хода', () => {
    // В датасете уже лежат две партии одним героем и с одним местом:
    // билда, героя и места мало.
    const same = record();
    const other = record({ checkpoints: [{ turn: 1, state: tavern(1, { shop: board([999]) }) }] });
    expect(gameSignature(same)).not.toBe(gameSignature(other));
  });

  it('другой герой, другое место, другой билд — другая партия', () => {
    const base = record();
    expect(gameSignature(record({ heroCardId: 'BG20_HERO_202' }))).not.toBe(gameSignature(base));
    expect(gameSignature(record({ finalPlace: 4 }))).not.toBe(gameSignature(base));
    expect(gameSignature(record({ buildNumber: 246003 }))).not.toBe(gameSignature(base));
  });

  it('порядок карт витрины отпечатка не меняет', () => {
    const straight = record({
      checkpoints: [{ turn: 1, state: tavern(1, { shop: board([201, 202]) }) }],
    });
    const reversed = record({
      checkpoints: [{ turn: 1, state: tavern(1, { shop: board([202, 201]) }) }],
    });
    expect(gameSignature(straight)).toBe(gameSignature(reversed));
  });

  it('запись без единой точки решения отпечаток всё же имеет', () => {
    expect(() => gameSignature(record({ checkpoints: [] }))).not.toThrow();
  });
});
