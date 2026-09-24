import { Worker } from 'node:worker_threads';

import type { ReportJobRequest, ReportJobResult } from './job.js';
import type { ReportWorkerMessage } from './worker.js';

/**
 * Разбор партии в отдельном потоке — для приложения в трее.
 *
 * Главный поток Electron держит трей, оверлей и его мост; синхронный
 * разбор на десятки секунд там заморозил бы приложение как раз на входе
 * в следующую партию.
 */

/** Путь к потоку рядом с этим файлом: `.ts` под tsx, `.js` в сборке. */
function workerUrl(): URL {
  const self = import.meta.url;
  return new URL(self.endsWith('.ts') ? './worker.ts' : './worker.js', self);
}

/** Потоку под tsx нужен свой загрузчик — см. `live/position/client.ts`. */
function workerExecArgv(url: URL): string[] {
  return url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [];
}

export function buildReportInWorker(request: ReportJobRequest): Promise<ReportJobResult> {
  const url = workerUrl();
  const worker = new Worker(url, { workerData: request, execArgv: workerExecArgv(url) });
  return new Promise<ReportJobResult>((resolve, reject) => {
    let settled = false;
    worker.once('message', (message: ReportWorkerMessage) => {
      settled = true;
      if (message.type === 'done') resolve(message.result);
      else reject(new Error(message.message));
      void worker.terminate();
    });
    worker.once('error', (error: unknown) => {
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    worker.once('exit', (code) => {
      if (!settled) reject(new Error(`поток разбора вышел с кодом ${String(code)} без ответа`));
    });
  });
}
