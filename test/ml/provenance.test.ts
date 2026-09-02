import { describe, expect, it } from 'vitest';

import type { DatasetRecord } from '../../src/dataset/recorder.js';
import type { DatasetGame } from '../../src/ml/dataset.js';
import {
  DEFAULT_FILTER,
  contributorOf,
  filterGames,
  formatProvenance,
  overlayOf,
  parseDatasetFilter,
  provenanceRows,
} from '../../src/ml/provenance.js';
import { EMPTY_STATE } from '../../src/state/types.js';
import { board } from '../minions.js';

/**
 * Отбор партий по тому, ЧЬИ они и шёл ли оверлей.
 *
 * До 02.09.2026 читатели датасета не различали своих и чужих вовсе, и первый
 * же принятый архив исполнителя молча смешал бы в одно среднее две разные
 * величины: «чей выбор лучше — игрока или советника» (свои партии)
 * и «каков уровень исполнителя» (чужие).
 */

function game(
  fileName: string,
  extra: Partial<Pick<DatasetRecord, 'contributor' | 'contributorRating' | 'overlay'>> = {},
): DatasetGame {
  const record: DatasetRecord = {
    savedAt: '2026-09-02T00:00:00.000Z',
    buildNumber: 250339,
    heroCardId: 'BG33_HERO_001',
    finalPlace: 4,
    checkpoints: [{ turn: 1, state: { ...EMPTY_STATE, turn: 1, shop: board([201]) } }],
    ...extra,
  };
  return { fileName, finalPlace: 4, record };
}

describe('чья партия и с подсказками ли сыграна', () => {
  it('отсутствие поля contributor значит СВОЯ партия, а не «неизвестно»', () => {
    expect(contributorOf(game('own.json'))).toBeNull();
    expect(contributorOf(game('c-vasya_1.json', { contributor: 'vasya' }))).toBe('vasya');
    // Пустая строка — тоже своя: `dataset:import` без псевдонима её и пишет.
    expect(contributorOf(game('x.json', { contributor: '' }))).toBeNull();
  });

  it('а вот у оверлея отсутствие значит НЕ СКАЗАНО — это разные вещи', () => {
    // Живой рекордер флага не писал, и выдавать его молчание за «оверлея
    // не было» нельзя: партии-то как раз сыграны по подсказкам.
    expect(overlayOf(game('old.json'))).toBeNull();
    expect(overlayOf(game('a.json', { overlay: false }))).toBe(false);
    expect(overlayOf(game('b.json', { overlay: true }))).toBe(true);
  });

  it('умолчание — свои партии: чужие в выборку сами не попадают', () => {
    const games = [game('own.json'), game('c-vasya.json', { contributor: 'vasya' })];
    expect(filterGames(games, DEFAULT_FILTER).map((g) => g.fileName)).toEqual(['own.json']);
    expect(filterGames(games, { who: 'contributors', overlay: 'any' }).map((g) => g.fileName)).toEqual(
      ['c-vasya.json'],
    );
    expect(filterGames(games, { who: 'all', overlay: 'any' })).toHaveLength(2);
  });

  it('фильтр оверлея не пропускает записи, у которых он НЕ СКАЗАН', () => {
    const games = [
      game('unknown.json'),
      game('off.json', { overlay: false }),
      game('on.json', { overlay: true }),
    ];
    expect(filterGames(games, { who: 'all', overlay: 'off' }).map((g) => g.fileName)).toEqual([
      'off.json',
    ]);
    expect(filterGames(games, { who: 'all', overlay: 'on' }).map((g) => g.fileName)).toEqual([
      'on.json',
    ]);
    expect(filterGames(games, { who: 'all', overlay: 'any' })).toHaveLength(3);
  });

  it('счёт по людям: свои первыми, дальше исполнители по числу партий', () => {
    const games = [
      game('c-petya_1.json', { contributor: 'petya', overlay: false }),
      game('own.json'),
      game('c-vasya_1.json', { contributor: 'vasya', overlay: false, contributorRating: 6500 }),
      game('c-vasya_2.json', { contributor: 'vasya', overlay: true }),
    ];
    const rows = provenanceRows(games);
    expect(rows.map((r) => r.contributor)).toEqual([null, 'vasya', 'petya']);
    expect(rows[1]).toMatchObject({
      games: 2,
      rating: 6500,
      withOverlay: 1,
      withoutOverlay: 1,
      overlayUnknown: 0,
    });
    expect(rows[0]).toMatchObject({ games: 1, rating: null, overlayUnknown: 1 });
  });

  it('разбор флагов: неизвестное значение — ошибка, а не тихое умолчание', () => {
    expect(parseDatasetFilter([])).toEqual(DEFAULT_FILTER);
    expect(parseDatasetFilter(['--games=all', '--overlay=off'])).toEqual({
      who: 'all',
      overlay: 'off',
    });
    expect(() => parseDatasetFilter(['--games=чужие'])).toThrow(/неизвестная выборка/);
    expect(() => parseDatasetFilter(['--overlay=maybe'])).toThrow(/неизвестный фильтр/);
  });

  it('отчёт говорит вслух, что чужие партии не вошли', () => {
    const games = [game('own.json'), game('c-vasya.json', { contributor: 'vasya' })];
    const lines = formatProvenance(games, DEFAULT_FILTER).join('\n');
    expect(lines).toContain('своих партий 1');
    expect(lines).toContain('от исполнителей 1');
    expect(lines).toContain('партий 1 из 2');
    expect(lines).toContain('чужие партии НЕ вошли');
  });
});
