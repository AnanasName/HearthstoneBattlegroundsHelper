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
    const advice = await worker.advise([episode], { budgetMs: 1500, screenBudgetMs: 700 });

    expect(advice).not.toBeNull();
    expect(advice?.top[0]?.board).toHaveLength(episode.playerBoard.length);
    expect(advice?.report.evaluated).toBeGreaterThan(1);
  }, 60_000);

  it('главный поток не стоит, пока идёт счёт', async () => {
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 20);
    try {
      await worker.advise([episode], { budgetMs: 1500, screenBudgetMs: 700 });
    } finally {
      clearInterval(timer);
    }

    // Синхронный счёт в главном потоке не дал бы таймеру ни одного срабатывания.
    expect(ticks.length).toBeGreaterThan(5);
  }, 60_000);

  it('новый запрос бросает незаконченный предыдущий', async () => {
    const stale = worker.advise([episode]);
    const fresh = worker.advise([episode], { budgetMs: 1500, screenBudgetMs: 700 });

    // null — это не «ничего не нашли», а «ответ уже никому не нужен».
    await expect(stale).resolves.toBeNull();
    await expect(fresh).resolves.not.toBeNull();
  }, 120_000);

  it('отмена прекращает счёт', async () => {
    const running = worker.advise([episode]);
    worker.cancel();

    await expect(running).resolves.toBeNull();
    expect(worker.busy).toBe(false);
  }, 120_000);

  it('досчитывает покупки и не отменяет расстановку', async () => {
    // Кандидаты — реальные борды эпизода: полный и без последнего миньона.
    const candidates = [
      { cardId: 'FULL', entityId: 1, boardAfter: episode.playerBoard },
      { cardId: 'SHORT', entityId: 2, boardAfter: episode.playerBoard.slice(0, -1) },
    ];

    // Оба вида работы в одной очереди, но со своими слотами отмены:
    // досчёт покупок не бросает счёт расстановки.
    const positionAdvice = worker.advise([episode], { budgetMs: 1500, screenBudgetMs: 700 });
    const buys = worker.checkBuys([episode], candidates, { simulations: 200, maxCandidates: 3 });

    const result = await buys;
    expect(result).not.toBeNull();
    expect(result?.outcomes).toHaveLength(2);
    expect(result?.outcomes[0]?.sims).toBeGreaterThan(0);
    // Полный борд не слабее себя без миньона.
    const full = result?.outcomes.find((o) => o.cardId === 'FULL');
    const short = result?.outcomes.find((o) => o.cardId === 'SHORT');
    expect((full?.outcome ?? 0) + 1e-9).toBeGreaterThanOrEqual(short?.outcome ?? 0);

    await expect(positionAdvice).resolves.not.toBeNull();
  }, 120_000);

  it('новый досчёт покупок бросает незаконченный предыдущий', async () => {
    const candidates = [
      { cardId: 'FULL', entityId: 1, boardAfter: episode.playerBoard },
      { cardId: 'SHORT', entityId: 2, boardAfter: episode.playerBoard.slice(0, -1) },
    ];

    const stale = worker.checkBuys([episode], candidates, { simulations: 3000, maxCandidates: 3 });
    const fresh = worker.checkBuys([episode], candidates, { simulations: 200, maxCandidates: 3 });

    await expect(stale).resolves.toBeNull();
    await expect(fresh).resolves.not.toBeNull();
  }, 120_000);
});
