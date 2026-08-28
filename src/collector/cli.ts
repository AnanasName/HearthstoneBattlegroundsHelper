import { loadConfig } from '../app/config.js';
import { APP_PATHS, GAMES_DIR } from '../app/paths.js';
import { APP_VERSION } from '../app/version.js';
import { checkGameSetup } from '../ui/setup.js';
import { detectLogsRoot } from '../watcher/installDir.js';
import { LogArchiver } from './archive.js';
import { exportArchive } from './export.js';

/**
 * Сборщик логов в терминале — тот же архиватор, что в трее, без Electron.
 *
 *   npm run collect                     следить и архивировать, Ctrl+C — стоп
 *   npm run collect -- --export         собрать архив для отправки и выйти
 *   npm run collect -- --logs-root <путь>
 *
 * Нужен затем же, зачем `npm run watch` оверлею: окно в среде разработки
 * не поднять (docs/live.md), а цикл «сессия → архив → tar → импорт»
 * проверять надо не только тестами.
 */

const version = APP_VERSION;

interface Args {
  readonly logsRoot: string | undefined;
  readonly export: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const i = argv.indexOf('--logs-root');
  return { logsRoot: i === -1 ? undefined : argv[i + 1], export: argv.includes('--export') };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logsRoot = detectLogsRoot(args.logsRoot ?? config.logsRoot);

  console.log(`логи игры: ${logsRoot}`);
  console.log(`архив:     ${GAMES_DIR}${APP_PATHS.packaged ? '' : ' (из репозитория)'}`);

  const archiver = new LogArchiver({
    logsRoot,
    gamesDir: GAMES_DIR,
    appVersion: version,
    overlay: () => config.overlay,
    onEvent: (event) => {
      switch (event.kind) {
        case 'archived':
          console.log(`сжато: ${event.session} (${(event.sourceBytes / 1024 / 1024).toFixed(1)} МБ источника)`);
          return;
        case 'tailing':
          console.log(`слежу: ${event.session}`);
          return;
        case 'error':
          console.error(`сбой архива: ${event.message}`);
          return;
      }
    },
  });

  if (args.export) {
    // Один опрос: досбор завершённых сессий плюс копия свежей с нуля —
    // без него в архив не попала бы сессия, в которой игрок только что играл.
    await archiver.tick();
    const result = await exportArchive(archiver, process.cwd(), version);
    console.log(
      `собрано: ${result.path} — сессий ${String(result.sessions)}, ${(result.bytes / 1024 / 1024).toFixed(1)} МБ`,
    );
    return;
  }

  const problem = checkGameSetup(logsRoot);
  if (problem !== null) console.log(problem.text);

  await archiver.start();
  console.log('Ctrl+C — остановить\n');

  process.on('SIGINT', () => {
    void archiver.stop().then(() => {
      process.exit(0);
    });
  });
}

void main();
