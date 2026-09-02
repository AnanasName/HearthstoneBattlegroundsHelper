import { describe, expect, it } from 'vitest';

import type { DatasetRecord } from '../../src/dataset/recorder.js';
import { lobbyKnown, refreshRecord } from '../../src/dataset/refresh.js';
import { EMPTY_STATE, type GameState, type Hero, type LobbyPlayer } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Досбор поверх лежащей записи: пересобрать (старая схема без `lobby`),
 * дописать журнал (текущая схема без `actions`) или не трогать.
 *
 * Фактура — датасет на 28.08: 28 записей старой схемы (part4–part26,
 * `lobby` нет ни в одной точке) и 10 с таблицей лобби во всех точках.
 * Проба по 23 партиям показала, что свежие точки у четырёх партий
 * не совпадают со старыми по числу (part12, part16, part22, part24) —
 * отсюда пересборка точек целиком, а не дописывание поля.
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

const LOBBY: Readonly<Record<number, LobbyPlayer>> = {
  3: {
    playerId: 3,
    heroCardId: 'BG33_HERO_001',
    health: 30,
    damage: 0,
    armor: 5,
    techLevel: 1,
    place: 4,
  },
  5: {
    playerId: 5,
    heroCardId: 'TB_BaconShop_HERO_33',
    health: 30,
    damage: 0,
    armor: 16,
    techLevel: 1,
    place: 2,
  },
};

function tavern(turn: number, patch: Partial<GameState> = {}): GameState {
  return {
    ...EMPTY_STATE,
    phase: 'tavern',
    turn,
    hero: HERO,
    gold: 5,
    goldTotal: 5,
    buildNumber: 248348,
    shop: board([200 + turn]),
    ...patch,
  };
}

/** Точка записи старой схемы: поля `lobby` в состоянии нет вовсе. */
function legacyPoint(turn: number): DatasetRecord['checkpoints'][number] {
  const withoutLobby = Object.fromEntries(
    Object.entries(tavern(turn)).filter(([key]) => key !== 'lobby'),
  ) as unknown as GameState;
  return { turn, state: withoutLobby };
}

function recordOf(
  checkpoints: DatasetRecord['checkpoints'],
  patch: Partial<DatasetRecord> = {},
): DatasetRecord {
  return {
    savedAt: '2026-08-17T12:02:10.000Z',
    buildNumber: 248348,
    heroCardId: HERO.cardId,
    finalPlace: 1,
    checkpoints,
    ...patch,
  };
}

const FRESH = recordOf(
  [
    { turn: 1, state: tavern(1, { lobby: LOBBY }) },
    { turn: 3, state: tavern(3, { lobby: LOBBY }) },
    { turn: 5, state: tavern(5, { lobby: LOBBY }) },
  ],
  {
    savedAt: '2026-08-28T20:00:00.000Z',
    actions: [{ turn: 1, type: 'buy', cardId: 'BG33_140', entityId: 201, subOption: null }],
  },
);

describe('таблица лобби в записи', () => {
  it('записи старой схемы поля нет ни в одной точке — не знает', () => {
    expect(lobbyKnown(recordOf([legacyPoint(1), legacyPoint(3)]))).toBe(false);
  });

  it('пустая таблица во всех точках — тоже не знает: её писал редьюсер без тега', () => {
    expect(lobbyKnown(recordOf([{ turn: 1, state: tavern(1, { lobby: {} }) }]))).toBe(false);
  });

  it('таблица хоть в одной точке — знает', () => {
    expect(lobbyKnown(FRESH)).toBe(true);
  });
});

describe('досбор поверх лежащей записи', () => {
  it('старая схема пересобирается: точки и журнал свежие, паспорт записи прежний', () => {
    const stored = recordOf([legacyPoint(1), legacyPoint(3)], {
      actions: [{ turn: 1, type: 'buy', cardId: 'OLD', entityId: null, subOption: null }],
      contributor: 'alice',
      contributorRating: 7000,
      overlay: false,
    });

    const plan = refreshRecord(stored, FRESH);

    expect(plan.action).toBe('rebuild');
    // Точек стало столько, сколько даёт сегодняшний редьюсер, — у четырёх
    // партий датасета это число другое, и старые точки не переносятся.
    expect(plan.record.checkpoints).toBe(FRESH.checkpoints);
    expect(plan.record.actions).toBe(FRESH.actions);
    expect(lobbyKnown(plan.record)).toBe(true);
    // Того, чего в логе нет, досбор не выдумывает и не теряет.
    expect(plan.record.savedAt).toBe('2026-08-17T12:02:10.000Z');
    expect(plan.record.contributor).toBe('alice');
    expect(plan.record.contributorRating).toBe(7000);
    expect(plan.record.overlay).toBe(false);
    expect(plan.record.finalPlace).toBe(1);
  });

  it('текущая схема без журнала: дописывается только журнал, точки не трогаются', () => {
    const points = [{ turn: 1, state: tavern(1, { lobby: LOBBY }) }];
    const stored = recordOf(points);

    const plan = refreshRecord(stored, FRESH);

    expect(plan.action).toBe('patchActions');
    expect(plan.record.checkpoints).toBe(points);
    expect(plan.record.actions).toBe(FRESH.actions);
  });

  it('текущая схема с журналом остаётся как есть', () => {
    const stored = recordOf([{ turn: 1, state: tavern(1, { lobby: LOBBY }) }], { actions: [] });

    const plan = refreshRecord(stored, FRESH);

    expect(plan.action).toBe('keep');
    expect(plan.record).toBe(stored);
  });

  it('--rebuild пересобирает и запись текущей схемы: точка решения сдвинулась по определению, а не по схеме', () => {
    // 29.08: снимок стал браться перед событием траты — старые точки
    // отличаются от новых моментом, и по полям этого не видно.
    const stored = recordOf([{ turn: 1, state: tavern(1, { lobby: LOBBY }) }], {
      actions: [],
      contributor: 'alice',
      overlay: true,
    });

    const plan = refreshRecord(stored, FRESH, true);

    expect(plan.action).toBe('rebuild');
    expect(plan.record.checkpoints).toBe(FRESH.checkpoints);
    expect(plan.record.actions).toBe(FRESH.actions);
    expect(plan.record.savedAt).toBe(stored.savedAt);
    expect(plan.record.contributor).toBe('alice');
    expect(plan.record.overlay).toBe(true);
  });
});
