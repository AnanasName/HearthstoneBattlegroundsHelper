import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_NAME, CARDS_FILE, repoRootOf, resolveAppPaths } from '../../src/app/paths.js';

/**
 * Пути приложения: из репозитория — `data/` рядом с исходниками, из сборки —
 * данные рядом с исполняемым файлом, записи в профиле пользователя.
 *
 * Дефект, ради которого модуль появился: все пути были строками
 * от рабочего каталога, и у исполнителя с инсталлятором рекордер датасета
 * пытался бы создать `data/dataset` там, откуда запущен ярлык.
 */

const MODULE_URL = pathToFileURL(join('C:', 'repo', 'src', 'app', 'paths.ts')).href;
const DIST_URL = pathToFileURL(join('C:', 'repo', 'dist', 'app', 'paths.js')).href;

describe('пути приложения', () => {
  it('корень репозитория одинаков из src и из dist', () => {
    expect(repoRootOf(MODULE_URL)).toBe(join('C:', 'repo'));
    expect(repoRootOf(DIST_URL)).toBe(join('C:', 'repo'));
  });

  it('без сборки оба корня — data/ репозитория', () => {
    const paths = resolveAppPaths({
      env: {},
      resourcesPath: undefined,
      exists: () => false,
      moduleUrl: MODULE_URL,
    });
    expect(paths.packaged).toBe(false);
    expect(paths.dataDir).toBe(join('C:', 'repo', 'data'));
    expect(paths.homeDir).toBe(join('C:', 'repo', 'data'));
  });

  it('под Electron без сборки resourcesPath указывает в node_modules — это не сборка', () => {
    const resourcesPath = join('C:', 'repo', 'node_modules', 'electron', 'dist', 'resources');
    const paths = resolveAppPaths({
      env: { LOCALAPPDATA: join('C:', 'Users', 'x', 'AppData', 'Local') },
      resourcesPath,
      exists: () => false,
      moduleUrl: DIST_URL,
    });
    expect(paths.packaged).toBe(false);
    expect(paths.homeDir).toBe(join('C:', 'repo', 'data'));
  });

  it('в сборке данные рядом с программой, записи — в профиле пользователя', () => {
    const resourcesPath = join('C:', 'Program Files', 'HS BG Assistant', 'resources');
    const paths = resolveAppPaths({
      env: { LOCALAPPDATA: join('C:', 'Users', 'x', 'AppData', 'Local') },
      resourcesPath,
      exists: (p) => p === join(resourcesPath, 'data', CARDS_FILE),
      moduleUrl: pathToFileURL(join(resourcesPath, 'app', 'dist', 'app', 'paths.js')).href,
    });
    expect(paths.packaged).toBe(true);
    expect(paths.dataDir).toBe(join(resourcesPath, 'data'));
    expect(paths.homeDir).toBe(join('C:', 'Users', 'x', 'AppData', 'Local', APP_NAME));
    expect(paths.homeDir.includes(`${sep}Program Files${sep}`)).toBe(false);
  });

  it('переменные окружения перекрывают любое правило', () => {
    const paths = resolveAppPaths({
      env: { HSBG_DATA_DIR: join('D:', 'd'), HSBG_HOME: join('D:', 'h') },
      resourcesPath: undefined,
      exists: () => false,
      moduleUrl: MODULE_URL,
    });
    expect(paths.dataDir).toBe(join('D:', 'd'));
    expect(paths.homeDir).toBe(join('D:', 'h'));
  });
});
