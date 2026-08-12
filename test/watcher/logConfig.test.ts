import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ensurePowerLogging,
  inspectLogConfig,
  readSectionKey,
} from '../../src/watcher/logConfig.js';

/**
 * Включение записи Power.log.
 *
 * Без этого файла данных нет вовсе, а по ТЗ приложение чинит настройки само:
 * требовать от игрока правки ini — верный способ получить неработающего
 * помощника и виноватого игрока.
 *
 * Образец разбирается настоящий — тот, что лежит на машине разработки
 * (`%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`): с комментариями,
 * несколькими секциями и ключами, которых мы не трогаем.
 */

const REAL_SAMPLE = [
  '; Ключи, которые реально читает Blizzard.T5.Logging.dll:',
  ';   ConsolePrinting, ScreenPrinting, FilePrinting',
  '',
  '[Power]',
  'FilePrinting=true',
  'ConsolePrinting=false',
  'Verbose=true',
  'TruncatePos=200000',
  '',
  '[LoadingScreen]',
  'FilePrinting=true',
  '',
].join('\r\n');

describe('log.config', () => {
  let dir: string | null = null;

  const write = (text: string): string => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-cfg-'));
    const path = join(dir, 'log.config');
    writeFileSync(path, text, 'utf8');
    return path;
  };

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('ключ читается из своей секции, а не из соседней', () => {
    expect(readSectionKey(REAL_SAMPLE, 'Power', 'FilePrinting')).toBe('true');
    expect(readSectionKey(REAL_SAMPLE, 'Power', 'ConsolePrinting')).toBe('false');
    // Ключ есть в обеих секциях — важно не перепутать.
    expect(readSectionKey(REAL_SAMPLE, 'LoadingScreen', 'FilePrinting')).toBe('true');
    expect(readSectionKey(REAL_SAMPLE, 'Power', 'ЧегоНет')).toBeNull();
  });

  it('настоящий конфиг признаётся годным и не трогается', () => {
    const path = write(REAL_SAMPLE);

    expect(inspectLogConfig(path).powerToFile).toBe(true);
    expect(ensurePowerLogging(path)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(REAL_SAMPLE);
  });

  it('отсутствующий файл создаётся', () => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-cfg-'));
    const path = join(dir, 'нет', 'log.config');

    expect(inspectLogConfig(path).exists).toBe(false);
    expect(ensurePowerLogging(path)).toBe(true);
    expect(inspectLogConfig(path).powerToFile).toBe(true);
  });

  it('чужие секции при починке остаются на месте', () => {
    const path = write(['[LoadingScreen]', 'FilePrinting=true', ''].join('\r\n'));

    expect(ensurePowerLogging(path)).toBe(true);

    const text = readFileSync(path, 'utf8');
    expect(inspectLogConfig(path).powerToFile).toBe(true);
    // Сносить настройки других каналов мы права не имеем.
    expect(readSectionKey(text, 'LoadingScreen', 'FilePrinting')).toBe('true');
  });

  it('выключенная печать включается, соседние ключи секции целы', () => {
    const path = write(
      ['[Power]', 'FilePrinting=false', 'TruncatePos=200000', ''].join('\r\n'),
    );

    expect(inspectLogConfig(path).powerToFile).toBe(false);
    expect(ensurePowerLogging(path)).toBe(true);

    const text = readFileSync(path, 'utf8');
    expect(readSectionKey(text, 'Power', 'FilePrinting')).toBe('true');
    expect(readSectionKey(text, 'Power', 'TruncatePos')).toBe('200000');
  });

  it('секция без ключа получает его, не съев следующую секцию', () => {
    const path = write(
      ['[Power]', 'Verbose=true', '[LoadingScreen]', 'FilePrinting=true', ''].join('\r\n'),
    );

    expect(ensurePowerLogging(path)).toBe(true);

    const text = readFileSync(path, 'utf8');
    expect(readSectionKey(text, 'Power', 'FilePrinting')).toBe('true');
    expect(readSectionKey(text, 'Power', 'Verbose')).toBe('true');
    expect(readSectionKey(text, 'LoadingScreen', 'FilePrinting')).toBe('true');
  });
});
