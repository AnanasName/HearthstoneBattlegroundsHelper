/**
 * Отдать поток воркера vitest посреди долгой синхронной работы.
 *
 * Воркер отвечает раннеру по RPC, и тайм-аут этого канала — 60 секунд,
 * зашитые в vitest (`DEFAULT_TIMEOUT` у birpc, из конфига не меняется).
 * Цикл, который держит поток дольше минуты, не успевает принять ответ:
 * таймер срабатывает раньше, чем обработается пришедшее сообщение, и прогон
 * падает ошибкой «[vitest-worker]: Timeout calling "onTaskUpdate"» при
 * полностью зелёных тестах — с кодом выхода 1.
 *
 * Замер 15.09.2026 на тяжёлом наборе: 7 таких ошибок при 15 воркерах
 * и 5 при шести, время 287 против 272 секунд. Число воркеров, значит,
 * ни при чём. Причина — циклы по всем событиям партии со снимком состояния
 * на каждом: part25 держал поток 269 секунд подряд.
 *
 *   const breather = createBreather();
 *   for (const event of readPowerEvents(text)) {
 *     if (breather.due()) await breather.pause();
 *     …
 *   }
 */
export interface Breather {
  /** Пора ли отдать поток. Часы читаются раз в 256 вызовов — цикл не тормозит. */
  due(): boolean;
  /** Отдать поток: раннер успеет принять и отправить сообщения. */
  pause(): Promise<void>;
}

export function createBreather(intervalMs = 2_000): Breather {
  let last = performance.now();
  let calls = 0;
  return {
    due(): boolean {
      calls += 1;
      if (calls % 256 !== 0) return false;
      return performance.now() - last >= intervalMs;
    },
    async pause(): Promise<void> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      last = performance.now();
    },
  };
}
