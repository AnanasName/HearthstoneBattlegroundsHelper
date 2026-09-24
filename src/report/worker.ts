import { parentPort, workerData } from 'node:worker_threads';

import { createBattleSimulator } from '../advisors/battle/simulator.js';
import { loadFieldBoards } from '../advisors/strength/boards.js';
import { loadCardIndex } from '../data/cards.js';
import { runReportJob, type ReportJobRequest, type ReportJobResult } from './job.js';

/**
 * Поток разбора партии: одна сборка на поток, и поток уходит.
 *
 * Отдельно от воркера советников (`live/position/worker.ts`) намеренно:
 * там новый запрос своего вида отменяет предыдущий, и разбор, пущенный
 * после партии, гасил бы живые советы следующей. Разбор редок (раз
 * в партию) и долог (до пяти минут на 85 МБ), а память после него лучше
 * вернуть — поэтому поток на задачу, а не постоянный.
 */

export type ReportWorkerMessage =
  | { readonly type: 'done'; readonly result: ReportJobResult }
  | { readonly type: 'failed'; readonly message: string };

const port = parentPort;
if (port === null) throw new Error('report/worker.ts запущен не как воркер');

const request = workerData as ReportJobRequest;
const deps = { cards: loadCardIndex(), simulator: createBattleSimulator(), field: loadFieldBoards() };

runReportJob(request, deps).then(
  (result) => {
    port.postMessage({ type: 'done', result } satisfies ReportWorkerMessage);
  },
  (error: unknown) => {
    port.postMessage({
      type: 'failed',
      message: error instanceof Error ? error.message : String(error),
    } satisfies ReportWorkerMessage);
  },
);
