import { Worker } from 'node:worker_threads';

import type { BattleSetup } from '../../advisors/battle/mapper.js';
import type { PositionAdvice } from '../../advisors/position/advisor.js';
import type { SearchOptions } from '../../advisors/position/search.js';
import {
  DEFAULT_BUY_CHECK_OPTIONS,
  type BuyCandidate,
  type BuyCheckOptions,
  type BuyCheckResult,
} from '../../advisors/tavern/simulated.js';
import {
  BUYS_SLOT,
  NO_TASK,
  POSITION_SLOT,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerSetup,
} from './protocol.js';

/**
 * Советники в отдельном потоке: расстановка и досчёт покупок.
 *
 * Заводится один раз при старте и живёт до конца работы: смысл именно в том,
 * чтобы справочник карт грузился однажды. Новый запрос своего вида
 * автоматически отменяет незаконченный предыдущий; виды друг друга
 * не отменяют — устройство слотов описано в protocol.ts.
 */

interface Waiting<T> {
  readonly resolve: (value: T | null) => void;
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
  readonly #pending = new Int32Array(new SharedArrayBuffer(8));
  readonly #waitingPosition = new Map<number, Waiting<PositionAdvice>>();
  readonly #waitingBuys = new Map<number, Waiting<BuyCheckResult>>();
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
      if (!this.#closed) this.#failAll(new Error(`воркер советников умер, код ${String(code)}`));
    });
  }

  /** Дождаться загрузки карт. Возвращает, сколько она заняла, мс. */
  ready(): Promise<number> {
    return this.#ready;
  }

  /**
   * Посчитать совет по расстановке, бросив предыдущий незаконченный.
   *
   * `null` означает, что счёт прерван более свежим запросом или отменой:
   * состояние ушло вперёд, и ответ относился бы уже не к нему.
   */
  advise(
    setups: readonly BattleSetup[],
    overrides: Partial<SearchOptions> = {},
  ): Promise<PositionAdvice | null> {
    if (this.#closed) return Promise.reject(new Error('воркер советников закрыт'));

    const id = this.#nextId++;
    // Объявление себя и отмена предыдущего — одно действие, поэтому
    // между ними ничего не вклинится.
    Atomics.store(this.#pending, POSITION_SLOT, id);

    return new Promise<PositionAdvice | null>((resolve, reject) => {
      this.#waitingPosition.set(id, { resolve, reject });
      const request: WorkerRequest = { type: 'advise', id, setups, overrides };
      this.#worker.postMessage(request);
    });
  }

  /**
   * Досчитать покупки боем, бросив предыдущий незаконченный досчёт.
   * Расстановку этот запрос не отменяет — у него свой слот.
   */
  checkBuys(
    setups: readonly BattleSetup[],
    candidates: readonly BuyCandidate[],
    options: BuyCheckOptions = DEFAULT_BUY_CHECK_OPTIONS,
  ): Promise<BuyCheckResult | null> {
    if (this.#closed) return Promise.reject(new Error('воркер советников закрыт'));

    const id = this.#nextId++;
    Atomics.store(this.#pending, BUYS_SLOT, id);

    return new Promise<BuyCheckResult | null>((resolve, reject) => {
      this.#waitingBuys.set(id, { resolve, reject });
      const request: WorkerRequest = { type: 'checkBuys', id, setups, candidates, options };
      this.#worker.postMessage(request);
    });
  }

  /** Бросить весь счёт: ответы больше не нужны. */
  cancel(): void {
    Atomics.store(this.#pending, POSITION_SLOT, NO_TASK);
    Atomics.store(this.#pending, BUYS_SLOT, NO_TASK);
  }

  /** Идёт ли счёт, которого ещё ждут. */
  get busy(): boolean {
    return this.#waitingPosition.size > 0 || this.#waitingBuys.size > 0;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.cancel();
    await this.#worker.terminate();
    this.#failAll(new Error('воркер советников закрыт'));
  }

  #receive(message: WorkerMessage): void {
    if (message.type === 'ready') return;

    if (message.type === 'advice') {
      const waiting = this.#waitingPosition.get(message.id);
      this.#waitingPosition.delete(message.id);
      waiting?.resolve(message.advice);
      return;
    }
    if (message.type === 'buys') {
      const waiting = this.#waitingBuys.get(message.id);
      this.#waitingBuys.delete(message.id);
      waiting?.resolve(message.result);
      return;
    }

    // Брошенный счёт и сбой не говорят, какого вида была задача, —
    // номер задачи уникален на оба вида, ищем в обеих очередях.
    const position = this.#waitingPosition.get(message.id);
    if (position !== undefined) {
      this.#waitingPosition.delete(message.id);
      if (message.type === 'aborted') position.resolve(null);
      else position.reject(new Error(message.message));
      return;
    }
    const buys = this.#waitingBuys.get(message.id);
    if (buys !== undefined) {
      this.#waitingBuys.delete(message.id);
      if (message.type === 'aborted') buys.resolve(null);
      else buys.reject(new Error(message.message));
    }
  }

  #failAll(error: Error): void {
    for (const waiting of this.#waitingPosition.values()) waiting.reject(error);
    this.#waitingPosition.clear();
    for (const waiting of this.#waitingBuys.values()) waiting.reject(error);
    this.#waitingBuys.clear();
  }
}
