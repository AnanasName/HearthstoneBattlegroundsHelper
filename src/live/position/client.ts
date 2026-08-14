import { Worker } from 'node:worker_threads';

import type { BattleSetup } from '../../advisors/battle/mapper.js';
import type { PositionAdvice } from '../../advisors/position/advisor.js';
import type { SearchOptions } from '../../advisors/position/search.js';
import { NO_TASK, type WorkerMessage, type WorkerRequest, type WorkerSetup } from './protocol.js';

/**
 * Советник расстановки в отдельном потоке.
 *
 * Заводится один раз при старте и живёт до конца работы: смысл именно в том,
 * чтобы справочник карт грузился однажды. Новый совет автоматически отменяет
 * незаконченный предыдущий — устройство отмены описано в protocol.ts.
 */

interface Waiting {
  readonly resolve: (advice: PositionAdvice | null) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Путь к воркеру рядом с этим файлом.
 *
 * Под tsx исходники запускаются как есть, после сборки — как .js. Расширение
 * берётся от собственного модуля, чтобы работало и там, и там.
 */
function workerUrl(): URL {
  const self = import.meta.url;
  return new URL(self.endsWith('.ts') ? './worker.ts' : './worker.js', self);
}

/**
 * Воркеру нужен свой разбор TypeScript.
 *
 * Поток запускается голым Node: загрузчик, которым главный поток читает
 * исходники, на него не распространяется. Под `npm run watch` это незаметно,
 * потому что tsx регистрируется на процесс, а под vitest воркер падал на
 * первом же импорте с `.js`, за которым лежит `.ts`. Собранному коду ничего
 * этого не нужно — там уже настоящие `.js`.
 */
function workerExecArgv(url: URL): string[] {
  return url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [];
}

export class PositionWorker {
  readonly #pending = new Int32Array(new SharedArrayBuffer(4));
  readonly #waiting = new Map<number, Waiting>();
  readonly #worker: Worker;
  readonly #ready: Promise<number>;
  #nextId = 1;
  #closed = false;

  constructor(cardsPath?: string) {
    const setup: WorkerSetup = { pending: this.#pending.buffer, cardsPath };
    const url = workerUrl();
    this.#worker = new Worker(url, { workerData: setup, execArgv: workerExecArgv(url) });

    this.#ready = new Promise<number>((resolve, reject) => {
      this.#worker.once('message', (message: WorkerMessage) => {
        if (message.type === 'ready') resolve(message.loadMs);
        else reject(new Error('воркер заговорил не с готовности'));
      });
      this.#worker.once('error', reject);
    });

    this.#worker.on('message', (message: WorkerMessage) => {
      this.#receive(message);
    });
    this.#worker.on('error', (error: Error) => {
      this.#failAll(error);
    });
    this.#worker.on('exit', (code) => {
      if (!this.#closed) this.#failAll(new Error(`воркер расстановки умер, код ${String(code)}`));
    });
  }

  /** Дождаться загрузки карт. Возвращает, сколько она заняла, мс. */
  ready(): Promise<number> {
    return this.#ready;
  }

  /**
   * Посчитать совет, бросив предыдущий незаконченный.
   *
   * `null` означает, что счёт прерван более свежим запросом или отменой:
   * состояние ушло вперёд, и ответ относился бы уже не к нему.
   */
  advise(
    setups: readonly BattleSetup[],
    overrides: Partial<SearchOptions> = {},
  ): Promise<PositionAdvice | null> {
    if (this.#closed) return Promise.reject(new Error('воркер расстановки закрыт'));

    const id = this.#nextId++;
    // Объявление себя и отмена предыдущего — одно действие, поэтому
    // между ними ничего не вклинится.
    Atomics.store(this.#pending, 0, id);

    return new Promise<PositionAdvice | null>((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      const request: WorkerRequest = { type: 'advise', id, setups, overrides };
      this.#worker.postMessage(request);
    });
  }

  /** Бросить счёт: ответ больше не нужен. */
  cancel(): void {
    Atomics.store(this.#pending, 0, NO_TASK);
  }

  /** Идёт ли счёт, которого ещё ждут. */
  get busy(): boolean {
    return this.#waiting.size > 0;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.cancel();
    await this.#worker.terminate();
    this.#failAll(new Error('воркер расстановки закрыт'));
  }

  #receive(message: WorkerMessage): void {
    if (message.type === 'ready') return;

    const waiting = this.#waiting.get(message.id);
    if (waiting === undefined) return;
    this.#waiting.delete(message.id);

    if (message.type === 'advice') waiting.resolve(message.advice);
    else if (message.type === 'aborted') waiting.resolve(null);
    else waiting.reject(new Error(message.message));
  }

  #failAll(error: Error): void {
    for (const waiting of this.#waiting.values()) waiting.reject(error);
    this.#waiting.clear();
  }
}
