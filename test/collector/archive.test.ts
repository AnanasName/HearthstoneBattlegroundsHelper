import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LogArchiver, type ArchiverEvent, type SessionMeta } from '../../src/collector/archive.js';
import { exportArchive, type ExportManifest } from '../../src/collector/export.js';
import { readTar } from '../../src/collector/tar.js';

/**
 * Архив логов на настоящих файлах: папки сессий как у клиента
 * (`Hearthstone_YYYY_MM_DD_hh_mm_ss`), завершённые сжимаются досбором,
 * свежая тянется живьём, смена сессии дожимает прежнюю, экспорт кладёт
 * всё в один tar с манифестом.
 */

const S1 = 'Hearthstone_2026_08_27_20_00_00';
const S2 = 'Hearthstone_2026_08_28_01_07_50';
const S3 = 'Hearthstone_2026_08_28_15_00_00';

describe('архив Power.log по сессиям', () => {
  let logsRoot: string;
  let gamesDir: string;
  let events: ArchiverEvent[];

  beforeEach(() => {
    logsRoot = mkdtempSync(join(tmpdir(), 'hsbg-logs-'));
    gamesDir = mkdtempSync(join(tmpdir(), 'hsbg-games-'));
    events = [];
  });

  afterEach(() => {
    rmSync(logsRoot, { recursive: true, force: true });
    rmSync(gamesDir, { recursive: true, force: true });
  });

  function session(name: string, text: string | null): string {
    const dir = join(logsRoot, name);
    mkdirSync(dir);
    const path = join(dir, 'Power.log');
    if (text !== null) writeFileSync(path, text, 'utf8');
    return path;
  }

  function meta(name: string): SessionMeta {
    return JSON.parse(readFileSync(join(gamesDir, `${name}.meta.json`), 'utf8')) as SessionMeta;
  }

  function unzipped(name: string): string {
    return gunzipSync(readFileSync(join(gamesDir, `${name}.Power.log.gz`))).toString('utf8');
  }

  function archiver(overlay = false): LogArchiver {
    return new LogArchiver({
      logsRoot,
      gamesDir,
      appVersion: '0.1.0',
      overlay: () => overlay,
      now: () => new Date('2026-08-28T12:00:00Z'),
      onEvent: (e) => {
        events.push(e);
      },
    });
  }

  it('досбор сжимает завершённые сессии, свежая тянется живьём и дожимается при остановке', async () => {
    session(S1, 'старая сессия\n');
    const live = session(S2, 'D 01:08:00 первая строка\n');

    const a = archiver(true);
    await a.start();

    // Завершённая — с диска, полностью.
    expect(unzipped(S1)).toBe('старая сессия\n');
    expect(meta(S1)).toMatchObject({ session: S1, complete: true, overlay: null, appVersion: '0.1.0' });
    // Свежая — ещё не сжата, но копируется.
    expect(existsSync(join(gamesDir, `${S2}.Power.log.gz`))).toBe(false);
    expect(a.live).toEqual({ session: S2, bytes: Buffer.byteLength('D 01:08:00 первая строка\n') });

    appendFileSync(live, 'D 01:09:00 вторая строка\n');
    await a.tick();
    await a.stop();

    expect(unzipped(S2)).toBe('D 01:08:00 первая строка\nD 01:09:00 вторая строка\n');
    // Снимок живой сессии: источник мог расти дальше, и флаг оверлея — от записи.
    expect(meta(S2)).toMatchObject({ complete: false, overlay: true });
    expect(events.map((e) => e.kind)).toEqual(['archived', 'tailing', 'archived']);
  });

  it('смена сессии клиента: прежняя дожимается с источника как завершённая', async () => {
    const first = session(S2, 'первая\n');
    const a = archiver();
    await a.start();

    // Клиент перезапущен: новая папка, а в старую он успел дописать после нашего снимка.
    appendFileSync(first, 'хвост\n');
    session(S3, 'новая\n');
    await a.tick();

    expect(unzipped(S2)).toBe('первая\nхвост\n');
    expect(meta(S2).complete).toBe(true);
    expect(a.live?.session).toBe(S3);
    // Копия прежней сессии больше не нужна — источник полнее.
    expect(existsSync(join(gamesDir, `${S2}.Power.log.part`))).toBe(false);
    await a.stop();
  });

  it('досбор без start() создаёт каталог архива сам — так его зовёт экспорт из терминала', async () => {
    session(S1, 'старая\n');
    session(S2, null);
    rmSync(gamesDir, { recursive: true, force: true });
    const a = archiver();
    await expect(a.sweep()).resolves.toEqual([S1]);
    expect(unzipped(S1)).toBe('старая\n');
  });

  it('досбор не пересжимает то, что уже лежит полностью', async () => {
    session(S1, 'старая\n');
    session(S2, null);
    const a = archiver();
    await a.start();
    await a.stop();
    const before = readFileSync(join(gamesDir, `${S1}.meta.json`), 'utf8');

    const b = archiver();
    await b.start();
    await b.stop();
    expect(readFileSync(join(gamesDir, `${S1}.meta.json`), 'utf8')).toBe(before);
    expect(events.filter((e) => e.kind === 'archived')).toHaveLength(1);
  });

  it('сирота .part без источника сжимается как есть, а не теряется', async () => {
    // Приложение упало, не дожав копию, а клиент папку почистил.
    writeFileSync(join(gamesDir, `${S1}.Power.log.part`), 'обрывок\n');
    session(S2, null);
    const a = archiver();
    await a.start();
    await a.stop();

    expect(unzipped(S1)).toBe('обрывок\n');
    expect(meta(S1).complete).toBe(false);
    expect(existsSync(join(gamesDir, `${S1}.Power.log.part`))).toBe(false);
  });

  it('обрезанный клиентом источник начинает копию заново', async () => {
    const live = session(S2, 'первая версия\n');
    const a = archiver();
    await a.start();
    writeFileSync(live, 'короче\n');
    await a.tick();
    await a.stop();
    expect(unzipped(S2)).toBe('короче\n');
  });

  it('экспорт: живая сессия снимается, всё уходит в один tar с манифестом', async () => {
    session(S1, 'старая\n');
    session(S2, 'живая\n');
    const a = archiver(true);
    await a.start();

    const outDir = join(gamesDir, 'out');
    const result = await exportArchive(a, outDir, '0.1.0', new Date('2026-08-28T12:34:56Z'));
    await a.stop();

    expect(result.sessions).toBe(2);
    expect(result.path).toBe(join(outDir, 'hsbg-logs_2026-08-28_12-34.tar'));

    const entries = readTar(readFileSync(result.path));
    expect(entries.map((e) => e.name)).toEqual([
      'manifest.json',
      `${S1}.Power.log.gz`,
      `${S1}.meta.json`,
      `${S2}.Power.log.gz`,
      `${S2}.meta.json`,
    ]);
    const manifest = JSON.parse(entries[0]?.data.toString('utf8') ?? '') as ExportManifest;
    expect(manifest.format).toBe('hsbg-logs/1');
    expect(manifest.sessions.map((s) => [s.session, s.complete, s.overlay])).toEqual([
      [S1, true, null],
      [S2, false, true],
    ]);
    expect(gunzipSync(entries[3]?.data ?? Buffer.alloc(0)).toString('utf8')).toBe('живая\n');
  });
});
