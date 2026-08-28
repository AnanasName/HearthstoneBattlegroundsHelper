import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  detectLogsRoot,
  findHearthstoneInstall,
  parseInstallLocation,
  UNINSTALL_KEY,
  type InstallProbe,
} from '../../src/watcher/installDir.js';
import { DEFAULT_LOGS_ROOT } from '../../src/watcher/logPaths.js';

/**
 * Вывод `reg query` снят с машины разработки 28.08.2026 дословно:
 * заголовок, пустые строки, значение с четырьмя пробелами между колонками
 * и CRLF на конце строк.
 */
const REG_OUTPUT =
  '\r\n' +
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Hearthstone\r\n' +
  '    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Hearthstone\r\n' +
  '\r\n';

function probe(overrides: Partial<InstallProbe> = {}): InstallProbe {
  return {
    registryQuery: () => null,
    exists: () => false,
    drives: () => ['C:\\', 'D:\\'],
    ...overrides,
  };
}

describe('поиск каталога Hearthstone', () => {
  it('читает InstallLocation из вывода reg query, без хвостового CR', () => {
    expect(parseInstallLocation(REG_OUTPUT)).toBe('C:\\Program Files (x86)\\Hearthstone');
    expect(parseInstallLocation('')).toBeNull();
    expect(parseInstallLocation('ERROR: The system was unable to find the specified key')).toBeNull();
  });

  it('реестр — первый источник, но каталог обязан содержать игру', () => {
    const queried: string[] = [];
    const found = findHearthstoneInstall(
      probe({
        registryQuery: (key, value) => {
          queried.push(`${key}/${value}`);
          return REG_OUTPUT;
        },
        exists: (p) => p === join('C:\\Program Files (x86)\\Hearthstone', 'Hearthstone.exe'),
      }),
    );
    expect(found).toBe('C:\\Program Files (x86)\\Hearthstone');
    expect(queried).toEqual([`${UNINSTALL_KEY}/InstallLocation`]);
  });

  it('запись реестра без игры на диске не верится — идёт перебор дисков', () => {
    const found = findHearthstoneInstall(
      probe({
        registryQuery: () => REG_OUTPUT,
        exists: (p) => p === join('D:\\', 'Games\\Hearthstone', 'Hearthstone.exe'),
      }),
    );
    expect(found).toBe(join('D:\\', 'Games\\Hearthstone'));
  });

  it('без реестра и без игры на дисках — null, а каталог логов — прежняя константа', () => {
    expect(findHearthstoneInstall(probe())).toBeNull();
    expect(detectLogsRoot(null, probe())).toBe(DEFAULT_LOGS_ROOT);
  });

  it('явный путь из настроек стоит выше любого поиска', () => {
    const p = probe({ registryQuery: () => REG_OUTPUT, exists: () => true });
    expect(detectLogsRoot('E:\\hs\\Logs', p)).toBe('E:\\hs\\Logs');
    expect(detectLogsRoot('', p)).toBe(join('C:\\Program Files (x86)\\Hearthstone', 'Logs'));
  });
});
