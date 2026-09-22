/**
 * Очередь задач с пределом одновременности.
 *
 * Зачем. Батарея гоняла замеры строго друг за другом: прогон 22.09 — это
 * 1801 с у `validate:tavern`, 3030 с у `validate:spend` и 1207 с
 * у `calibrate`, то есть 6038 с в одно ядро из шестнадцати. Замеры
 * независимы — каждый свой процесс со своим снапшотом карт, — и общего
 * состояния у них нет.
 *
 * Почему это НЕ меняет числа. Зерно симулятора берётся от содержимого боя,
 * а не от номера вызова (`seededSimulator`, D134), поэтому исход боя
 * не зависит ни от порядка задач, ни от того, что считалось рядом.
 * Единственное, что меняет одновременность, — `durationSec`, и это замер
 * времени, а не качества.
 *
 * Порядок результатов — входной, а не порядок финиша: иначе итог прогона
 * зависел бы от того, какой замер сегодня оказался быстрее.
 */

/**
 * Прогнать `run` по всем `items`, держа в работе не больше `limit` задач.
 *
 * Предел меньше единицы считается единицей: ноль означал бы прогон, который
 * молча ничего не делает. Падение любой задачи всплывает наружу — батарея
 * должна упасть, а не записать итог по половине замеров.
 */
export async function runPool<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const width = Math.min(Math.max(1, Math.trunc(limit)), items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T, index);
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}
