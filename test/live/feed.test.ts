import { describe, expect, it } from 'vitest';

import { GameFeed } from '../../src/live/feed.js';
import { LineAssembler } from '../../src/live/lines.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { mulberry32 } from '../../src/advisors/position/rng.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { fixtureBytes, part2Game, part3Game } from '../fixtures.js';

/**
 * Живой путь обязан давать ровно то же состояние, что и пакетный.
 *
 * Это не украшение, а единственная защита от расхождения двух путей: пакетным
 * проверены все фазы 1–4, а советовать в игре будет живой. Всё, что их
 * различает, — порядок появления строк, и именно он здесь и ломается нарочно:
 * файл скармливается порциями случайного размера, включая однобайтовые.
 */

/** Снимки состояния через равные промежутки по событиям плюс итоговый. */
function batchSnapshots(text: string, every: number): GameState[] {
  const reducer = createReducer(readPlayers(text));
  const out: GameState[] = [];

  let events = 0;
  for (const event of readPowerEvents(text)) {
    reducer.step(event);
    events += 1;
    if (events % every === 0) out.push(reducer.snapshot());
  }
  out.push(reducer.snapshot());
  return out;
}

/**
 * То же, но через живой путь: байты → строки → события → состояние.
 *
 * Размеры порций берутся от воспроизводимого генератора и нарочно бывают
 * крошечными: порция в один байт гарантированно режет и CRLF, и многобайтовый
 * символ UTF-8.
 */
function liveSnapshots(bytes: Buffer, every: number, seed: number): GameState[] {
  const random = mulberry32(seed);
  const lines = new LineAssembler();
  const feed = new GameFeed();
  const out: GameState[] = [];

  let taken = 0;
  const drain = (batch: readonly string[]): void => {
    for (const line of batch) {
      feed.pushLines([line]);
      // Снимок берётся по счётчику событий, а не строк: у пакетного пути
      // счётчика строк нет, а события у обоих путей одни и те же.
      //
      // Счётчик скачет один раз за партию — когда стал известен свой игрок
      // и накопленный пролог прогоняется в редьюсер разом. Промежуток между
      // контрольными точками нарочно больше пролога (тот около 250 строк),
      // иначе точка попала бы внутрь скачка и сравнивала бы не тот момент.
      while (feed.events >= (taken + 1) * every) {
        taken += 1;
        const state = feed.snapshot();
        if (state !== null) out.push(state);
      }
    }
  };

  let offset = 0;
  while (offset < bytes.length) {
    // 1–8192 байта: и однобайтовые порции, и близкие к настоящему чтению.
    const size = 1 + Math.floor(random() * 8192);
    drain(lines.push(bytes.subarray(offset, offset + size)));
    offset += size;
  }
  drain(lines.flush());

  const final = feed.snapshot();
  if (final !== null) out.push(final);
  return out;
}

describe('живой разбор совпадает с пакетным', () => {
  for (const part of ['part2', 'part3'] as const) {
    it(`${part}: состояние в контрольных точках и в конце партии`, () => {
      const text = part === 'part2' ? part2Game() : part3Game();
      const every = 2000;

      const batch = batchSnapshots(text, every);
      const live = liveSnapshots(fixtureBytes(part), every, 7);

      // Сравнивать одно лишь итоговое состояние мало: расхождение посреди
      // партии может к концу затянуться. Контрольных точек должно быть много.
      expect(batch.length).toBeGreaterThan(20);
      expect(live.length).toBe(batch.length);
      for (const [i, expected] of batch.entries()) {
        // Полное сравнение состояния, а не выборочных полей: расхождение
        // в любом теге любого миньона — это уже расхождение путей.
        expect(live[i], `снимок ${String(i)}`).toEqual(expected);
      }
    }, 120_000);
  }

  it('партия опознаётся по CREATE_GAME, а игрок — до первого события', () => {
    const feed = new GameFeed();
    const lines = new LineAssembler();
    const bytes = fixtureBytes('part3');

    // Первых 64 КБ хватает: объявления Player идут в дампе CREATE_GAME.
    feed.pushLines(lines.push(bytes.subarray(0, 65_536)));

    expect(feed.gamesSeen).toBe(1);
    expect(feed.game?.id).toBe(1);
    expect(feed.game?.players.selfPlayerId).not.toBeNull();
    expect(feed.game?.players.selfName).not.toBeNull();
    expect(feed.snapshot()).not.toBeNull();
    expect(feed.diagnostics.buffered).toBe(0);
  });

  it('до первого CREATE_GAME состояния нет, а строки посчитаны', () => {
    const feed = new GameFeed();
    feed.pushLines([
      'D 23:53:33.6072835 GameState.DebugPrintPower() -     TAG_CHANGE Entity=10 tag=TURN value=3',
      'D 23:53:33.6072835 GameState.DebugPrintGame() - GameType=GT_BATTLEGROUNDS',
    ]);

    expect(feed.snapshot()).toBeNull();
    expect(feed.game).toBeNull();
    expect(feed.diagnostics.beforeFirstGame).toBe(2);
  });

  it('CREATE_GAME из канала PowerTaskList новой партии не начинает', () => {
    const feed = new GameFeed();
    feed.pushLines(['D 23:53:33.6072835 PowerTaskList.DebugPrintPower() -     CREATE_GAME']);

    expect(feed.gamesSeen).toBe(0);
  });
});
