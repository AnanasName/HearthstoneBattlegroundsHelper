import { parentPort, workerData } from 'node:worker_threads';

import { createBattleSimulator } from '../../advisors/battle/simulator.js';
import { advisePosition, SearchAborted } from '../../advisors/position/advisor.js';
import { BuyCheckAborted, checkBuysWithBattle } from '../../advisors/tavern/simulated.js';
import {
  BUYS_SLOT,
  POSITION_SLOT,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerSetup,
} from './protocol.js';

/**
 * Воркер советников: держит справочник карт, считает расстановку и досчёт
 * покупок. Устройство разговора и слоты отмены — в protocol.ts.
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
    if (request.type === 'checkBuys') {
      const result = checkBuysWithBattle(
        request,
        {
          simulator,
          // Ждут не нас — значит, ответ уже никому не нужен.
          aborted: () => Atomics.load(pending, BUYS_SLOT) !== request.id,
        },
        request.options,
      );
      reply({ type: 'buys', id: request.id, result });
      return;
    }

    const advice = advisePosition(
      request.setups,
      {
        simulator,
        aborted: () => Atomics.load(pending, POSITION_SLOT) !== request.id,
      },
      request.overrides,
    );
    reply({ type: 'advice', id: request.id, advice });
  } catch (error) {
    if (error instanceof SearchAborted || error instanceof BuyCheckAborted) {
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
