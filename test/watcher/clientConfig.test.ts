import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_LIMIT_KB,
  DESIRED_LIMIT_KB,
  ensureLogSizeLimit,
  inspectClientConfig,
  readLimitKb,
} from '../../src/watcher/clientConfig.js';

describe('readLimitKb', () => {
  it('читает ключ из секции — так его нашёл клиент в эксперименте', () => {
    expect(readLimitKb('[Log]\r\nFileSizeLimit.Int=44\r\n')).toBe(44);
  });

  it('читает и плоскую запись без секции', () => {
    // ConfigFile склеивает полный ключ как "{секция}.{ключ}", а при пустой
    // секции берёт ключ как есть — значит оба варианта равносильны.
    expect(readLimitKb('Log.FileSizeLimit.Int=1000000\r\n')).toBe(1_000_000);
  });

  it('не путает ключ из чужой секции', () => {
    expect(readLimitKb('[Net]\r\nFileSizeLimit.Int=44\r\n')).toBeNull();
  });

  it('пропускает комментарии и пустые строки', () => {
    expect(readLimitKb('; комментарий\r\n\r\n[Log]\r\n; ещё\r\nFileSizeLimit.Int=7\r\n')).toBe(7);
  });

  it('переносит смену секции', () => {
    expect(readLimitKb('[Net]\r\nFileSizeLimit.Int=1\r\n[Log]\r\nFileSizeLimit.Int=2\r\n')).toBe(2);
  });

  it('возвращает null, если ключа нет или значение не число', () => {
    expect(readLimitKb('[Log]\r\nSomethingElse=5\r\n')).toBeNull();
    expect(readLimitKb('[Log]\r\nFileSizeLimit.Int=абв\r\n')).toBeNull();
  });
});

describe('inspectClientConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-cc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('без файла действует дефолт клиента, и его не хватает', () => {
    const s = inspectClientConfig(dir);
    expect(s.exists).toBe(false);
    expect(s.limitKb).toBe(DEFAULT_LIMIT_KB);
    expect(s.sufficient).toBe(false);
  });

  it('дефолтные 10000 КБ недостаточны — на них обрывалась каждая партия BG', () => {
    writeFileSync(join(dir, 'client.config'), '[Log]\r\nFileSizeLimit.Int=10000\r\n');
    expect(inspectClientConfig(dir).sufficient).toBe(false);
  });

  it('наш предел достаточен', () => {
    writeFileSync(join(dir, 'client.config'), `[Log]\r\nFileSizeLimit.Int=${String(DESIRED_LIMIT_KB)}\r\n`);
    const s = inspectClientConfig(dir);
    expect(s.limitKb).toBe(DESIRED_LIMIT_KB);
    expect(s.sufficient).toBe(true);
  });

  it('отрицательное значение считается снятым лимитом', () => {
    writeFileSync(join(dir, 'client.config'), '[Log]\r\nFileSizeLimit.Int=-1\r\n');
    expect(inspectClientConfig(dir).sufficient).toBe(true);
  });
});

describe('ensureLogSizeLimit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-cc-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('создаёт файл, если его нет, и сообщает о необходимости перезапуска', () => {
    expect(ensureLogSizeLimit(dir)).toBe(true);

    const written = readFileSync(join(dir, 'client.config'), 'utf8');
    expect(readLimitKb(written)).toBe(DESIRED_LIMIT_KB);
    expect(written.startsWith('[Log]')).toBe(true);
  });

  it('чинит файл с дефолтным пределом', () => {
    writeFileSync(join(dir, 'client.config'), '[Log]\r\nFileSizeLimit.Int=10000\r\n');
    expect(ensureLogSizeLimit(dir)).toBe(true);
    expect(readLimitKb(readFileSync(join(dir, 'client.config'), 'utf8'))).toBe(DESIRED_LIMIT_KB);
  });

  it('не трогает уже правильный файл', () => {
    ensureLogSizeLimit(dir);
    expect(ensureLogSizeLimit(dir)).toBe(false);
  });

  it('записанное им самим читается им же — обновление игры может снести файл', () => {
    ensureLogSizeLimit(dir);
    const s = inspectClientConfig(dir);
    expect(s.exists).toBe(true);
    expect(s.sufficient).toBe(true);
  });
});
