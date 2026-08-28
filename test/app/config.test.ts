import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/app/config.js';
import { elevationCommand } from '../../src/app/elevate.js';

describe('настройки приложения', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('без файла, с битым файлом и с чужими ключами — умолчания', () => {
    const path = join(dir, 'config.json');
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
    writeFileSync(path, '{ не json');
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
    writeFileSync(path, JSON.stringify({ overlay: 'да', logsRoot: '', other: 1 }));
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
  });

  it('сохранённое читается обратно, каталог создаётся', () => {
    const path = join(dir, 'глубже', 'config.json');
    saveConfig({ overlay: true, logsRoot: 'D:\\Games\\Hearthstone\\Logs' }, path);
    expect(loadConfig(path)).toEqual({ overlay: true, logsRoot: 'D:\\Games\\Hearthstone\\Logs' });
    expect(readFileSync(path, 'utf8')).toContain('"overlay": true');
  });
});

describe('повышение прав', () => {
  it('команда PowerShell экранирует одинарные кавычки и ждёт код выхода', () => {
    const cmd = elevationCommand("C:\\Program Files\\HS BG Assistant\\HS BG Assistant.exe", [
      '--setup',
      '--logs-root',
      "D:\\O'Neil\\Hearthstone\\Logs",
    ]);
    expect(cmd.file).toBe('powershell.exe');
    expect(cmd.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    expect(cmd.args[3]).toBe(
      "$p = Start-Process -FilePath 'C:\\Program Files\\HS BG Assistant\\HS BG Assistant.exe'" +
        " -ArgumentList @('--setup','--logs-root','D:\\O''Neil\\Hearthstone\\Logs')" +
        ' -Verb RunAs -Wait -PassThru; exit $p.ExitCode',
    );
  });

  it('без аргументов -ArgumentList не пишется: PowerShell не принимает пустой список', () => {
    expect(elevationCommand('x.exe', []).args[3]).not.toContain('-ArgumentList');
  });
});
