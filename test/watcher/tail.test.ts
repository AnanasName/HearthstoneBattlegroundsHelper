import { mkdtempSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileTailer } from '../../src/watcher/tail.js';

describe('FileTailer', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-tail-'));
    file = join(dir, 'Power.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('на несуществующем файле молчит, а не падает', async () => {
    const tailer = new FileTailer(join(dir, 'нет-такого.log'));
    const read = await tailer.read();
    expect(read.data).toHaveLength(0);
    expect(read.restarted).toBe(false);
  });

  it('читает только дописанное с прошлого раза', async () => {
    writeFileSync(file, 'первая\r\n');
    const tailer = new FileTailer(file);

    expect((await tailer.read()).data.toString('utf8')).toBe('первая\r\n');
    expect((await tailer.read()).data).toHaveLength(0);

    appendFileSync(file, 'вторая\r\n');
    expect((await tailer.read()).data.toString('utf8')).toBe('вторая\r\n');
  });

  it('офсет считается в байтах, а не в символах', async () => {
    // Кириллица в UTF-8 занимает 2 байта на символ — офсет обязан это учитывать,
    // иначе следующее чтение начнётся с середины символа.
    writeFileSync(file, 'Клеопатра\r\n');
    const tailer = new FileTailer(file);

    await tailer.read();
    expect(tailer.offset).toBe(statSync(file).size);
    expect(tailer.offset).toBe('Клеопатра\r\n'.length + 9);
  });

  it('замечает обрезку файла и перечитывает его с начала', async () => {
    writeFileSync(file, 'старое содержимое\r\n');
    const tailer = new FileTailer(file);
    await tailer.read();

    writeFileSync(file, 'новое\r\n');
    const read = await tailer.read();

    expect(read.restarted).toBe(true);
    expect(read.data.toString('utf8')).toBe('новое\r\n');
  });

  it('не считает обрезкой файл ровно той же длины', async () => {
    writeFileSync(file, 'абв\r\n');
    const tailer = new FileTailer(file);
    await tailer.read();

    const read = await tailer.read();
    expect(read.restarted).toBe(false);
    expect(read.data).toHaveLength(0);
  });

  it('truncateSource обнуляет файл и сбрасывает офсет', async () => {
    writeFileSync(file, 'что-то длинное\r\n');
    const tailer = new FileTailer(file);
    await tailer.read();
    expect(tailer.offset).toBeGreaterThan(0);

    await tailer.truncateSource();

    expect(statSync(file).size).toBe(0);
    expect(tailer.offset).toBe(0);
  });

  it('после truncateSource читает дописанное с нуля без флага restarted', async () => {
    writeFileSync(file, 'до обрезки\r\n');
    const tailer = new FileTailer(file);
    await tailer.read();
    await tailer.truncateSource();

    appendFileSync(file, 'после обрезки\r\n');
    const read = await tailer.read();

    expect(read.data.toString('utf8')).toBe('после обрезки\r\n');
    expect(read.restarted).toBe(false);
  });
});
