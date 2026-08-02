/**
 * Запись Power.log в собственный архив, поверх ограничений клиента.
 *
 * Зачем: Hearthstone закрывает лог насовсем при достижении 10000 КБ и не
 * возобновляет запись (см. docs/power-log.md). Полная партия Battlegrounds
 * в этот предел не влезает. Утилита непрерывно вычитывает Power.log в наш файл
 * и, если попросить, обнуляет источник, не давая ему подойти к пределу.
 *
 *   npm run capture
 *   npm run capture -- --truncate-at=4
 *
 * --truncate-at=<МБ> включает обнуление источника. Это эксперимент: сработает
 * только если клиент сверяется с фактической длиной файла, а не со счётчиком.
 * Признак провала виден сразу — после обнуления файл прыгает обратно к прежнему
 * размеру, значит писатель сохранил позицию и получилась дыра из нулей.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DEFAULT_LOGS_ROOT, findLatestSession } from '../watcher/logPaths.js';
import { FileTailer } from '../watcher/tail.js';

const MIB = 1024 * 1024;

interface Options {
  readonly logsRoot: string;
  readonly outDir: string;
  readonly pollMs: number;
  readonly truncateAtBytes: number | null;
}

function parseArgs(argv: readonly string[]): Options {
  const get = (name: string): string | null => {
    const prefix = `--${name}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit === undefined ? null : hit.slice(prefix.length);
  };

  const truncateAt = get('truncate-at');
  return {
    logsRoot: get('logs-root') ?? DEFAULT_LOGS_ROOT,
    outDir: get('out-dir') ?? join(process.cwd(), 'data', 'logs-raw'),
    pollMs: Number(get('poll') ?? 1000),
    truncateAtBytes: truncateAt === null ? null : Math.round(Number(truncateAt) * MIB),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const mb = (bytes: number): string => (bytes / MIB).toFixed(2);

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  await mkdir(opts.outDir, { recursive: true });

  console.log(`лог-корень:  ${opts.logsRoot}`);
  console.log(`архив:       ${opts.outDir}`);
  console.log(
    opts.truncateAtBytes === null
      ? 'обнуление:   выключено'
      : `обнуление:   при ${mb(opts.truncateAtBytes)} МБ источника`,
  );
  console.log('Ctrl+C — остановить\n');

  let sessionName: string | null = null;
  let tailer: FileTailer | null = null;
  let outPath: string | null = null;
  let captured = 0;
  let truncations = 0;
  const startedAt = Date.now();

  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });

  let sinceStatus = 0;
  // Если после обнуления писатель сохранил позицию, файл станет разреженным:
  // клиент допишет в старый офсет, а начало окажется забито нулями. Ловим это
  // по первому же байту и выключаем обнуление, иначе получим цикл на каждом
  // опросе и мегабайты нулей в архиве.
  let justTruncated = false;
  let truncationDisabled = false;

  while (!stopping) {
    const session = findLatestSession(opts.logsRoot);

    if (session !== null && session.name !== sessionName) {
      sessionName = session.name;
      tailer = new FileTailer(join(session.dir, 'Power.log'));
      outPath = join(opts.outDir, `capture__${session.name}__Power.log`);
      captured = 0;
      truncations = 0;
      console.log(`\n>>> сессия ${session.name}\n>>> пишу в ${outPath}\n`);
    }

    if (tailer !== null && outPath !== null) {
      const { data, restarted } = await tailer.read();

      if (restarted) {
        console.log('!!! источник обрезали не мы — читаю с начала');
      }

      if (data.length > 0) {
        if (justTruncated && data[0] === 0) {
          truncationDisabled = true;
          console.log(
            '\n!!! ЭКСПЕРИМЕНТ ПРОВАЛЕН: после обнуления файл начинается с нулей.\n' +
              '!!! Писатель сохранил позицию, обнуление предела не обходит.\n' +
              '!!! Обнуление выключено, продолжаю просто вычитывать.\n',
          );
        }
        justTruncated = false;

        await appendFile(outPath, data);
        captured += data.length;
      }

      if (
        opts.truncateAtBytes !== null &&
        !truncationDisabled &&
        tailer.offset >= opts.truncateAtBytes
      ) {
        const before = tailer.offset;
        try {
          await tailer.truncateSource();
          truncations += 1;
          justTruncated = true;
          console.log(
            `--- обнулил источник на ${mb(before)} МБ (обнулений: ${truncations}, ` +
              `в архиве ${mb(captured)} МБ)`,
          );
        } catch (err) {
          // Проверено 02.08: пока клиент пишет в лог, он держит файл так, что
          // открыть его на запись нельзя — EBUSY. Обрезка снаружи невозможна.
          truncationDisabled = true;
          console.log(
            `\n!!! обнулить источник не вышло: ${String(err)}\n` +
              '!!! живой лог держит клиент, обрезка снаружи невозможна.\n' +
              '!!! продолжаю просто вычитывать.\n',
          );
        }
      }
    }

    sinceStatus += opts.pollMs;
    if (sinceStatus >= 15_000) {
      sinceStatus = 0;
      const minutes = (Date.now() - startedAt) / 60_000;
      const rate = minutes > 0 ? Number(mb(captured)) / minutes : 0;
      console.log(
        `[${new Date().toLocaleTimeString()}] в архиве ${mb(captured)} МБ, ` +
          `источник ${mb(tailer?.offset ?? 0)} МБ, ${rate.toFixed(2)} МБ/мин`,
      );
    }

    await sleep(opts.pollMs);
  }

  console.log(`\nостановлено. записано ${mb(captured)} МБ, обнулений: ${truncations}`);
  if (outPath !== null) console.log(`архив: ${outPath}`);
}

await main();
