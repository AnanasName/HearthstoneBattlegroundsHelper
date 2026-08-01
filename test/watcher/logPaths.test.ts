import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findLatestPowerLog,
  findLatestSession,
  listSessions,
} from '../../src/watcher/logPaths.js';

/**
 * Имена папок и состав файлов взяты с реальной машины:
 * C:\Program Files (x86)\Hearthstone\Logs содержал шесть сессий вида
 * Hearthstone_2026_08_01_22_30_56, и Power.log появился только после включения
 * log.config — в более старых сессиях его нет. См. docs/power-log.md.
 */
describe('logPaths', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hsbg-logs-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeSession(name: string, files: string[] = []): void {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const f of files) writeFileSync(join(dir, f), '');
  }

  it('возвращает пустой список, если папки логов не существует', () => {
    expect(listSessions(join(root, 'нет-такой'))).toEqual([]);
    expect(findLatestSession(join(root, 'нет-такой'))).toBeNull();
    expect(findLatestPowerLog(join(root, 'нет-такой'))).toBeNull();
  });

  it('игнорирует посторонние папки и файлы', () => {
    makeSession('Hearthstone_2026_08_01_22_30_56');
    makeSession('Crash_2026_08_01');
    writeFileSync(join(root, 'Hearthstone_2026_08_01_23_00_00'), '');

    expect(listSessions(root).map((s) => s.name)).toEqual([
      'Hearthstone_2026_08_01_22_30_56',
    ]);
  });

  it('сортирует сессии по времени из имени папки, от старых к новым', () => {
    makeSession('Hearthstone_2026_07_30_22_40_49');
    makeSession('Hearthstone_2026_08_01_22_30_56');
    makeSession('Hearthstone_2026_07_25_16_44_41');
    makeSession('Hearthstone_2026_08_01_13_10_48');

    expect(listSessions(root).map((s) => s.name)).toEqual([
      'Hearthstone_2026_07_25_16_44_41',
      'Hearthstone_2026_07_30_22_40_49',
      'Hearthstone_2026_08_01_13_10_48',
      'Hearthstone_2026_08_01_22_30_56',
    ]);
  });

  it('разбирает время запуска клиента из имени папки', () => {
    makeSession('Hearthstone_2026_08_01_22_30_56');

    const session = findLatestSession(root);
    expect(session?.startedAt).toEqual(new Date(2026, 7, 1, 22, 30, 56));
  });

  it('находит Power.log свежайшей сессии', () => {
    makeSession('Hearthstone_2026_07_30_22_40_49', ['Power.log']);
    makeSession('Hearthstone_2026_08_01_22_30_56', ['Power.log', 'Zone.log']);

    expect(findLatestPowerLog(root)).toBe(
      join(root, 'Hearthstone_2026_08_01_22_30_56', 'Power.log'),
    );
  });

  it('возвращает null, если в свежайшей сессии нет Power.log — логирование выключено', () => {
    makeSession('Hearthstone_2026_07_30_22_40_49', ['Power.log']);
    makeSession('Hearthstone_2026_08_01_22_30_56', ['Hearthstone.log']);

    expect(findLatestPowerLog(root)).toBeNull();
  });
});
