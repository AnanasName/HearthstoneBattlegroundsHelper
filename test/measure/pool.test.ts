import { describe, expect, it } from 'vitest';

import { runPool } from '../../src/measure/pool.js';

/** Отложенное обещание: тест сам решает, в каком порядке задачи финишируют. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('runPool', () => {
  it('возвращает результаты в порядке ВХОДА, а не завершения', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const run = runPool([0, 1, 2], 3, (i) => gates[i]!.promise);
    // Финишируют задом наперёд.
    gates[2]!.resolve('c');
    gates[1]!.resolve('b');
    gates[0]!.resolve('a');
    expect(await run).toEqual(['a', 'b', 'c']);
  });

  it('держит в работе не больше предела одновременно', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<number>());
    let started = 0;
    let peak = 0;
    let running = 0;
    const run = runPool(gates, 2, async (g) => {
      started++;
      running++;
      peak = Math.max(peak, running);
      const value = await g.promise;
      running--;
      return value;
    });
    await Promise.resolve();
    expect(started).toBe(2);
    // Освобождение одного слота пускает ровно одну следующую задачу.
    gates[0]!.resolve(0);
    await gates[0]!.promise;
    await Promise.resolve();
    for (const [i, g] of gates.entries()) g.resolve(i);
    expect(await run).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('предел больше числа задач берёт их все разом', async () => {
    let peak = 0;
    let running = 0;
    const result = await runPool([1, 2, 3], 10, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running--;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6]);
    expect(peak).toBe(3);
  });

  it('пустой список не зовёт задачу и не виснет', async () => {
    let calls = 0;
    expect(
      await runPool([], 4, () => {
        calls++;
        return Promise.resolve(1);
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  it('предел меньше единицы считается единицей, а не остановкой', async () => {
    let peak = 0;
    let running = 0;
    const result = await runPool([1, 2], 0, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      running--;
      return n;
    });
    expect(result).toEqual([1, 2]);
    expect(peak).toBe(1);
  });

  it('падение задачи всплывает наружу', async () => {
    await expect(
      runPool([1, 2, 3], 2, (n) => {
        // Синхронный бросок — случай злее отказа обещания: его тоже видно.
        if (n === 2) throw new Error('замер упал');
        return Promise.resolve(n);
      }),
    ).rejects.toThrow('замер упал');
  });
});
