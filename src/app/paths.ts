import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Где приложение читает данные и куда пишет своё.
 *
 * До этого модуля все пути были строками от рабочего каталога:
 * `data/cards/cards_enUS.json`, `data/dataset`. Это верно ровно в одном
 * случае — когда приложение запускают из клона репозитория командой npm.
 * У исполнителя, которому ПО передано инсталлятором, рабочий каталог
 * произвольный (ярлык, автозапуск), а каталог программы в Program Files
 * не пишется: первый же `mkdirSync` рекордера датасета упал бы внутри
 * обновления состояния — молча, потому что стандартный вывод GUI-сборки
 * Electron к терминалу не подключён (docs/live.md).
 *
 * Два корня, и смешивать их нельзя:
 *
 * - **dataDir** — только чтение: снапшот карт, статистика мест. В сборке
 *   лежит рядом с исполняемым файлом (`process.resourcesPath/data`,
 *   куда его кладёт electron-builder как extraResources).
 * - **homeDir** — запись: датасет, архив логов, настройки. В сборке —
 *   `%LOCALAPPDATA%\hs-bg-assistant`; тот же каталог, где сама игра
 *   держит `log.config` (`%LOCALAPPDATA%\Blizzard\Hearthstone`), то есть
 *   заведомо доступный пользователю без прав.
 *
 * В разработке оба корня — `data/` репозитория, как и было: датасет
 * по-прежнему копится в `data/dataset`, ничего не переезжает. Корень
 * берётся от собственного модуля, а не от `process.cwd()`: `src/app` и
 * `dist/app` лежат на одной глубине, и `../..` от любого из них — корень
 * репозитория, откуда бы команду ни запустили.
 *
 * Признак сборки — не `app.isPackaged` (это Electron, а пути нужны и CLI,
 * и тестам, и воркеру), а наличие снапшота карт в `resourcesPath`:
 * в Electron без сборки `resourcesPath` указывает внутрь `node_modules`,
 * и данных там нет. Переменные `HSBG_DATA_DIR` и `HSBG_HOME` перекрывают
 * любое из правил — для отладки сборки на своей машине.
 */

export const APP_NAME = 'hs-bg-assistant';

export interface AppPaths {
  /** Собранное приложение, а не запуск из репозитория. */
  readonly packaged: boolean;
  /** Данные только для чтения: карты, статистика. */
  readonly dataDir: string;
  /** Всё, что приложение пишет само. */
  readonly homeDir: string;
}

export interface PathsProbe {
  readonly env: NodeJS.ProcessEnv;
  /** `process.resourcesPath` — есть только под Electron. */
  readonly resourcesPath: string | undefined;
  readonly exists: (path: string) => boolean;
  /** `import.meta.url` этого модуля — от него считается корень репозитория. */
  readonly moduleUrl: string;
}

/** Файл, по которому узнаётся каталог данных: без него приложение слепо. */
export const CARDS_FILE = join('cards', 'cards_enUS.json');

function defaultProbe(): PathsProbe {
  return {
    env: process.env,
    resourcesPath: (process as { resourcesPath?: string }).resourcesPath,
    exists: existsSync,
    moduleUrl: import.meta.url,
  };
}

/** Корень репозитория: `src/app` и `dist/app` лежат на одной глубине. */
export function repoRootOf(moduleUrl: string): string {
  return join(dirname(fileURLToPath(moduleUrl)), '..', '..');
}

/** `%LOCALAPPDATA%\hs-bg-assistant`; без переменной — по профилю. */
export function localHomeDir(env: NodeJS.ProcessEnv): string {
  const local = env['LOCALAPPDATA'] ?? join(env['USERPROFILE'] ?? '.', 'AppData', 'Local');
  return join(local, APP_NAME);
}

export function resolveAppPaths(overrides: Partial<PathsProbe> = {}): AppPaths {
  const probe = { ...defaultProbe(), ...overrides };

  const packagedData =
    probe.resourcesPath !== undefined && probe.exists(join(probe.resourcesPath, 'data', CARDS_FILE))
      ? join(probe.resourcesPath, 'data')
      : null;

  const repoData = join(repoRootOf(probe.moduleUrl), 'data');
  const dataDir = probe.env['HSBG_DATA_DIR'] ?? packagedData ?? repoData;
  const homeDir =
    probe.env['HSBG_HOME'] ?? (packagedData === null ? repoData : localHomeDir(probe.env));

  return { packaged: packagedData !== null, dataDir, homeDir };
}

/** Пути этого процесса — считаются один раз при загрузке. */
export const APP_PATHS: AppPaths = resolveAppPaths();

export const CARDS_PATH = join(APP_PATHS.dataDir, CARDS_FILE);
export const BG_STATS_DIR = join(APP_PATHS.dataDir, 'bgstats');
/** Датасет собственных партий (фаза 6) и записи, принятые от исполнителей. */
export const DATASET_DIR = join(APP_PATHS.homeDir, 'dataset');
/** Архив Power.log по сессиям клиента — то, что исполнитель присылает. */
export const GAMES_DIR = join(APP_PATHS.homeDir, 'games');
/** Сырые архивы от исполнителей, как пришли: сырьё для фикстур. */
export const CONTRIB_DIR = join(APP_PATHS.homeDir, 'contrib');
export const CONFIG_PATH = join(APP_PATHS.homeDir, 'config.json');
