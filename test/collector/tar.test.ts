import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readTar, tarHeader, writeTar } from '../../src/collector/tar.js';

/**
 * Свой ustar: то, что записали, читается обратно, а штатный `tar.exe`
 * Windows 11 (bsdtar) видит в контейнере те же файлы — иначе исполнитель
 * получил бы файл, который не открыть ничем, кроме нашей же команды.
 */
describe('контейнер tar', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-tar-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('записанное читается обратно: данные, пустой файл, файл с диска, кириллица в имени', async () => {
    const onDisk = join(dir, 'session.log.gz');
    const blob = Buffer.from(Array.from({ length: 1500 }, (_, i) => i % 251));
    writeFileSync(onDisk, blob);

    const out = join(dir, 'export.tar');
    const mtime = new Date('2026-08-28T10:00:00Z');
    const bytes = await writeTar(out, [
      { name: 'manifest.json', data: Buffer.from('{"a":1}'), mtime },
      { name: 'empty.txt', data: Buffer.alloc(0), mtime },
      { name: 'games/Hearthstone_2026_08_28_01_07_50.Power.log.gz', path: onDisk, mtime },
      { name: 'заметка.txt', data: Buffer.from('привет', 'utf8'), mtime },
    ]);

    const tar = readFileSync(out);
    expect(tar.length).toBe(bytes);
    // Заголовок + данные с дополнением до 512 у каждого (7 байт → 1 блок,
    // пустой → 0, 1500 → 3, «привет» → 1), плюс два пустых блока в конце.
    expect(bytes).toBe(512 * (2 + 1 + 4 + 2) + 512 * 2);

    const entries = readTar(tar);
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'empty.txt',
      'games/Hearthstone_2026_08_28_01_07_50.Power.log.gz',
      'заметка.txt',
    ]);
    expect(entries[0]?.data.toString('utf8')).toBe('{"a":1}');
    expect(entries[1]?.data.length).toBe(0);
    expect(entries[2]?.data.equals(blob)).toBe(true);
    expect(entries[3]?.data.toString('utf8')).toBe('привет');
    expect(entries[0]?.mtime.toISOString()).toBe(mtime.toISOString());
  });

  it('контрольная сумма и разметка заголовка — по ustar', () => {
    const header = tarHeader('a.txt', 5, new Date(0));
    expect(header.length).toBe(512);
    expect(header.subarray(257, 263).toString('latin1')).toBe('ustar\0');
    expect(header.subarray(124, 136).toString('latin1')).toBe('00000000005\0');

    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
    expect(header.subarray(148, 156).toString('latin1')).toBe(`${sum.toString(8).padStart(6, '0')}\0 `);
  });

  it('длинное имя делится на prefix и name по «/», слишком длинное — ошибка', () => {
    const long = `${'d'.repeat(120)}/${'f'.repeat(60)}.gz`;
    const entries = readTar(Buffer.concat([tarHeader(long, 0, new Date(0)), Buffer.alloc(1024)]));
    expect(entries.map((e) => e.name)).toEqual([long]);
    expect(() => tarHeader('x'.repeat(150), 0, new Date(0))).toThrow(/не влезает/);
  });

  it('обрезанный архив не читается молча', () => {
    const header = tarHeader('a.bin', 1000, new Date(0));
    expect(() => readTar(Buffer.concat([header, Buffer.alloc(100)]))).toThrow(/обрезан/);
  });

  it('штатный tar.exe видит те же файлы', async () => {
    const out = join(dir, 'export.tar');
    await writeTar(out, [
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'games/s1.Power.log.gz', data: Buffer.alloc(700, 7) },
    ]);

    let listing: string;
    try {
      // Относительный путь: bsdtar читает `C:\…` как адрес удалённой машины.
      listing = execFileSync('tar', ['-tf', 'export.tar'], {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true,
      });
    } catch (error) {
      // tar.exe есть в Windows 10 1803+ и в любом Unix; его отсутствие —
      // особенность машины, а не дефект контейнера.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    expect(listing.split(/\r?\n/).filter((l) => l !== '')).toEqual([
      'manifest.json',
      'games/s1.Power.log.gz',
    ]);
  });
});
