import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, dialog, Menu, nativeImage, shell, Tray } from 'electron';

import { LogArchiver } from '../collector/archive.js';
import { exportArchive } from '../collector/export.js';
import { startOverlay, type OverlayHandle } from '../overlay/window.js';
import { checkGameSetup } from '../ui/setup.js';
import { detectLogsRoot, LOGS_DIR_NAME } from '../watcher/installDir.js';
import { loadConfig, saveConfig, type AppConfig } from './config.js';
import { runElevated } from './elevate.js';
import { APP_PATHS, GAMES_DIR } from './paths.js';
import { APP_VERSION } from './version.js';

/**
 * Приложение в трее: сборщик логов всегда, оверлей с советами — по желанию.
 *
 *   npm run collector                   сборка и трей
 *   npm run overlay                     то же с включённым оверлеем
 *   <exe> --setup                       починить настройки игры и выйти (с правами)
 *   <exe> --logs-root <путь>            папка логов вместо поиска
 *
 * ## Почему сборщик — умолчание, а оверлей — галочка
 *
 * ПО передаётся исполнителям ради датасета. Оверлей требует оконного
 * режима игры, свежего снапшота карт и меняет то, что собираем: партия
 * по подсказкам — не «как играют люди» (docs/ml.md). Сборщик же не требует
 * ничего: тянет Power.log и складывает по сессиям (`collector/archive.ts`).
 * Включён ли оверлей, пишется в метаданные каждой сессии.
 *
 * ## Настройки игры и права
 *
 * Оба конфига проверяются при каждом запуске (`ui/setup.ts`). `log.config`
 * лежит в профиле и правится без прав; `client.config` — в каталоге игры,
 * и в сборке приложение перезапускает себя через UAC с ключом `--setup`
 * (`elevate.ts`). Инсталлятор делает то же самое сразу после установки
 * (`build/installer.nsh`), так что запрос UAC при запуске — запасной путь.
 *
 * Стандартного вывода у GUI-сборки нет (docs/live.md), поэтому всё, что
 * должен узнать игрок, — в подсказке и меню трея.
 */

interface Args {
  readonly setup: boolean;
  readonly overlay: boolean;
  readonly logsRoot: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const i = argv.indexOf('--logs-root');
  return {
    setup: argv.includes('--setup'),
    overlay: argv.includes('--overlay'),
    logsRoot: i === -1 ? null : (argv[i + 1] ?? null),
  };
}

const args = parseArgs(process.argv.slice(APP_PATHS.packaged ? 1 : 2));

/**
 * Режим починки: повышенный экземпляр правит конфиги и выходит.
 * Код выхода читает тот, кто нас запустил (PowerShell в `elevate.ts`).
 */
if (args.setup) {
  const config = loadConfig();
  const problem = checkGameSetup(detectLogsRoot(args.logsRoot ?? config.logsRoot));
  app.exit(problem === null || problem.needsRestart ? 0 : 1);
}

let tray: Tray | null = null;
let archiver: LogArchiver | null = null;
let overlay: OverlayHandle | null = null;
let config: AppConfig = loadConfig();
let logsRoot = '';
let setupText: string | null = null;
let stopping = false;

function trayIcon(): Electron.NativeImage {
  const path = fileURLToPath(new URL('./icons/tray.png', import.meta.url));
  return nativeImage.createFromPath(path);
}

function overlayOn(): boolean {
  return overlay !== null;
}

function refreshTray(): void {
  if (tray === null) return;
  const archived = archiver?.listArchived().length ?? 0;
  const live = archiver?.live;
  const lines = [
    `HS BG Assistant ${APP_VERSION}`,
    `логи: ${logsRoot}`,
    `в архиве сессий: ${String(archived)}` + (live === null || live === undefined ? '' : `, слежу за ${live.session}`),
    ...(setupText === null ? [] : [setupText]),
  ];
  tray.setToolTip(lines.join('\n'));
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: lines[0] ?? '', enabled: false },
      { label: lines[2] ?? '', enabled: false },
      ...(setupText === null ? [] : [{ label: setupText, enabled: false }]),
      { type: 'separator' },
      {
        label: 'Оверлей с советами',
        type: 'checkbox',
        checked: overlayOn(),
        click: () => {
          void setOverlay(!overlayOn());
        },
      },
      {
        label: 'Собрать архив для отправки…',
        click: () => {
          void doExport();
        },
      },
      {
        label: 'Открыть папку с данными',
        click: () => {
          void shell.openPath(APP_PATHS.homeDir);
        },
      },
      {
        label: 'Указать папку Hearthstone…',
        click: () => {
          void pickLogsRoot();
        },
      },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

async function setOverlay(on: boolean): Promise<void> {
  if (on && overlay === null) {
    overlay = startOverlay({
      logsRoot,
      initialHeader: setupText,
      onHideRequested: () => {
        void setOverlay(false);
      },
    });
  } else if (!on && overlay !== null) {
    const handle = overlay;
    overlay = null;
    await handle.stop();
  }
  if (config.overlay !== on) {
    config = { ...config, overlay: on };
    saveConfig(config);
  }
  refreshTray();
}

async function doExport(): Promise<void> {
  if (archiver === null) return;
  try {
    const result = await exportArchive(archiver, app.getPath('desktop'), APP_VERSION);
    shell.showItemInFolder(result.path);
    await dialog.showMessageBox({
      type: 'info',
      title: 'Архив собран',
      message: `Файл для отправки: ${result.path}`,
      detail:
        `Сессий: ${String(result.sessions)}, размер ${(result.bytes / 1024 / 1024).toFixed(1)} МБ. ` +
        'Отправьте его любым удобным способом.',
    });
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Архив не собран',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function startArchiver(): Promise<void> {
  if (archiver !== null) await archiver.stop();
  archiver = new LogArchiver({
    logsRoot,
    gamesDir: GAMES_DIR,
    appVersion: APP_VERSION,
    overlay: overlayOn,
    onEvent: () => {
      refreshTray();
    },
  });
  await archiver.start();
  refreshTray();
}

async function pickLogsRoot(): Promise<void> {
  const picked = await dialog.showOpenDialog({
    title: 'Папка, где установлен Hearthstone',
    properties: ['openDirectory'],
  });
  const dir = picked.filePaths[0];
  if (picked.canceled || dir === undefined) return;

  // Игрок может показать и сам каталог игры, и папку Logs в нём.
  const withLogs = join(dir, LOGS_DIR_NAME);
  logsRoot = existsSync(withLogs) ? withLogs : dir;
  config = { ...config, logsRoot };
  saveConfig(config);

  await startArchiver();
  if (overlay !== null) {
    await setOverlay(false);
    await setOverlay(true);
  }
}

/** Проверить настройки игры; в сборке — починить client.config через UAC. */
function ensureGameSetup(): void {
  const problem = checkGameSetup(logsRoot);
  if (problem === null) {
    setupText = null;
    return;
  }
  if (problem.needsElevation === true && APP_PATHS.packaged) {
    const fixed = runElevated(process.execPath, ['--setup', '--logs-root', logsRoot]);
    setupText = fixed
      ? 'снял предел размера логов — перезапустите Hearthstone'
      : 'предел размера логов не снят: не хватило прав, партии будут обрываться';
    return;
  }
  setupText = problem.text;
}

if (!args.setup) {
  // Второй экземпляр в трее ничего не добавил бы — только два архиватора
  // на одном файле.
  if (!app.requestSingleInstanceLock()) app.quit();

  void app.whenReady().then(async () => {
    logsRoot = detectLogsRoot(args.logsRoot ?? config.logsRoot);
    ensureGameSetup();

    tray = new Tray(trayIcon());
    refreshTray();

    await startArchiver();
    if (args.overlay || config.overlay) await setOverlay(true);
  });

  // Приложение живёт в трее: закрытие окна оверлея — не выход.
  app.on('window-all-closed', () => undefined);

  app.on('before-quit', (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    // Сжать живую копию: что успели — то и сохранено.
    void Promise.all([overlay?.stop(), archiver?.stop()]).finally(() => {
      app.quit();
    });
  });
}
