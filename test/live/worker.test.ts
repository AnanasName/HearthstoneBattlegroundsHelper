import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodes, type BattleEpisode } from '../../src/advisors/battle/episodes.js';
import { PositionWorker } from '../../src/live/position/client.js';
import { part3Game } from '../fixtures.js';

/**
 * Воркер расстановки: считает в стороне и бросает счёт по требованию.
 *
 * Проверяется ровно то, ради чего он заведён, — что счёт не держит главный
 * поток и что устаревший счёт прерывается. Качество самого совета проверено
 * в фазе 3 и здесь не повторяется.
 */

describe('воркер расстановки', () => {
  let worker: PositionWorker;
  let episode: BattleEpisode;

  beforeAll(async () => {
    const episodes = readBattleEpisodes(part3Game());
    const found = episodes.find((e) => e.turn === 8);
    if (found === undefined) throw new Error('в part3 нет боя на ходу 8');
    episode = found;

    worker = new PositionWorker();
    await worker.ready();
  }, 180_000);

  afterAll(async () => {
    await worker.close();
  });

  it('считает совет и отвечает расстановкой', async () => {
    const advice = await worker.advise(episode, { budgetMs: 1500, screenBudgetMs: 700 });

    expect(advice).not.toBeNull();
    expect(advice?.top[0]?.board).toHaveLength(episode.playerBoard.length);
    expect(advice?.report.evaluated).toBeGreaterThan(1);
  }, 60_000);

  it('главный поток не стоит, пока идёт счёт', async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 20);
    try {
      await worker.advise(episode, { budgetMs: 1500, screenBudgetMs: 700 });
    } finally {
      clearInterval(timer);
    }

    // Синхронный счёт в главном потоке не дал бы таймеру ни одного срабатывания.
    expect(ticks.length).toBeGreaterThan(5);
  }, 60_000);

  it('новый запрос бросает незаконченный предыдущий', async () => {
    const stale = worker.advise(episode);
    const fresh = worker.advise(episode, { budgetMs: 1500, screenBudgetMs: 700 });

    // null — это не «ничего не нашли», а «ответ уже никому не нужен».
    await expect(stale).resolves.toBeNull();
    await expect(fresh).resolves.not.toBeNull();
  }, 120_000);

  it('отмена прекращает счёт', async () => {
    const running = worker.advise(episode);
    worker.cancel();

    await expect(running).resolves.toBeNull();
    expect(worker.busy).toBe(false);
  }, 120_000);
});
