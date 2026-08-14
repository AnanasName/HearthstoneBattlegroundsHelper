import { parentPort, workerData } from 'node:worker_threads';

import { createBattleSimulator } from '../../advisors/battle/simulator.js';
import { advisePosition, SearchAborted } from '../../advisors/position/advisor.js';
import type { WorkerMessage, WorkerRequest, WorkerSetup } from './protocol.js';

/**
 * Воркер расстановки: держит справочник карт и считает советы.
 *
 * Устройство разговора и почему отмена идёт через общую память — в protocol.ts.
 */

const port = parentPort;
if (port === null) throw new Error('worker.ts запущен не как воркер');

const setup = workerData as WorkerSetup;
const pending = new Int32Array(setup.pending);

const started = Date.now();
const simulator = createBattleSimulator(setup.cardsPath);
const ready: WorkerMessage = { type: 'ready', loadMs: Date.now() - started };
port.postMessage(ready);

port.on('message', (request: WorkerRequest) => {
  const reply = (message: WorkerMessage): void => {
    port.postMessage(message);
  };

  try {
    const advice = advisePosition(
      request.setups,
      {
        simulator,
        // Ждут не нас — значит, ответ уже никому не нужен.
        aborted: () => Atomics.load(pending, 0) !== request.id,
      },
      request.overrides,
    );
    reply({ type: 'advice', id: request.id, advice });
  } catch (error) {
    if (error instanceof SearchAborted) {
      reply({ type: 'aborted', id: request.id });
      return;
    }
    reply({
      type: 'failure',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
