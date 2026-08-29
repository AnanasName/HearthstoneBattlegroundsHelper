import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EXPORT_FORMAT, type ExportManifest } from '../../src/collector/export.js';
import { writeTar } from '../../src/collector/tar.js';
import { aliasOf, gameTypeOf, importArchive, sessionStamp, splitGames } from '../../src/dataset/import.js';
import { DatasetRecorder, type DatasetRecord } from '../../src/dataset/recorder.js';
import { GameFeed } from '../../src/live/feed.js';
import { LineAssembler } from '../../src/live/lines.js';
import { part7Game } from '../fixtures.js';

/**
 * Приём архива исполнителя на настоящей партии (part7, билд 248348,
 * 7-е место): партия принимается записью с пометкой исполнителя, повторный
 * архив даёт дубль, обрыв лога — отказ с причиной, сырой архив
 * раскладывается в contrib/.
 */

const SESSION = 'Hearthstone_2026_08_13_20_19_19';

describe('импорт архива логов', () => {
  let dir: string;
  let text: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-import-'));
    text = part7Game();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function makeArchive(name: string, log: string, overlay: boolean | null): Promise<string> {
    const meta = {
      session: SESSION,
      sourceBytes: Buffer.byteLength(log),
      complete: true,
      overlay,
      appVersion: '0.1.0',
      archivedAt: '2026-08-28T12:00:00.000Z',
    };
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      appVersion: '0.1.0',
      exportedAt: '2026-08-28T12:00:00.000Z',
      sessions: [{ ...meta, file: `${SESSION}.Power.log.gz`, gzBytes: 0 }],
    };
    const path = join(dir, name);
    await writeTar(path, [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
      { name: `${SESSION}.Power.log.gz`, data: gzipSync(Buffer.from(log, 'utf8')) },
      { name: `${SESSION}.meta.json`, data: Buffer.from(JSON.stringify(meta)) },
    ]);
    return path;
  }

  it('нарезает сессию на партии по CREATE_GAME канала-источника', () => {
    const log = [
      'D 20:19:00.0000000 GameState.DebugPrintGame() - прогрев',
      'D 20:19:19.3857739 GameState.DebugPrintPower() - CREATE_GAME',
      'D 20:19:19.3857739 GameState.DebugPrintPower() -     GameEntity EntityID=1',
      // Дубль из канала PowerTaskList партию НЕ начинает.
      'D 20:19:19.4000000 PowerTaskList.DebugPrintPower() - CREATE_GAME',
      'D 20:45:00.0000000 GameState.DebugPrintPower() - CREATE_GAME',
      'D 20:45:00.0000000 GameState.DebugPrintPower() -     GameEntity EntityID=1',
    ].join('\r\n');
    const games = splitGames(log);
    expect(games).toHaveLength(2);
    expect(games[0]?.split('\n')).toHaveLength(3);
    expect(games[1]?.split('\n')).toHaveLength(2);
  });

  it('псевдоним из BattleTag и штамп из имени сессии', () => {
    expect(aliasOf('AngryMem#2886')).toBe('AngryMem-2886');
    expect(aliasOf('Игрок#1')).toBe('Игрок-1');
    expect(aliasOf('#')).toBe('unknown');
    expect(sessionStamp(SESSION)).toBe('2026-08-13T20-19-19');
  });

  it('партия принимается записью исполнителя, повторный архив — дубль', async () => {
    const datasetDir = join(dir, 'dataset');
    const contribDir = join(dir, 'contrib');
    const tar = await makeArchive('hsbg-logs_2026-08-28_12-00.tar', text, true);

    const report = importArchive(tar, {
      datasetDir,
      contribDir,
      alias: null,
      rating: 8500,
      now: () => new Date('2026-08-28T13:00:00Z'),
    });

    expect(report.accepted).toHaveLength(1);
    expect(report.skipped).toEqual([]);
    const game = report.accepted[0];
    expect(game).toMatchObject({ session: SESSION, index: 1, finalPlace: 7, buildNumber: 248348, partial: false, overlay: true });
    expect(game?.checkpoints).toBeGreaterThan(5);
    // Псевдоним взят из лога — BattleTag игрока part7.
    expect(report.alias).toMatch(/^[\p{L}\p{N}_]+-\d+$/u);
    expect(game?.fileName).toBe(`c-${report.alias}_2026-08-13T20-19-19_g1_b248348_p7.json`);

    const record = JSON.parse(readFileSync(join(datasetDir, game?.fileName ?? ''), 'utf8')) as DatasetRecord;
    expect(record.contributor).toBe(report.alias);
    expect(record.contributorRating).toBe(8500);
    expect(record.overlay).toBe(true);
    expect(record.actions?.length).toBeGreaterThan(0);

    // Сырой архив разложен как пришёл.
    expect(report.rawDir).toBe(join(contribDir, report.alias, 'hsbg-logs_2026-08-28_12-00'));
    expect(readdirSync(report.rawDir).sort()).toEqual([
      `${SESSION}.Power.log.gz`,
      `${SESSION}.meta.json`,
      'manifest.json',
    ]);

    // Тот же архив второй раз — та же партия, дубль по отпечатку.
    const again = importArchive(tar, { datasetDir, contribDir, alias: 'кто-то', rating: null });
    expect(again.accepted).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(['дубль']);
    expect(readdirSync(datasetDir)).toHaveLength(1);
  }, 120_000);

  it('обрыв лога до конца партии — отказ с причиной, без записи', async () => {
    const datasetDir = join(dir, 'dataset-cut');
    const cut = text.slice(0, Math.floor(text.length * 0.5));
    const tar = await makeArchive('hsbg-logs_cut.tar', cut, null);

    const report = importArchive(tar, { datasetDir, contribDir: join(dir, 'contrib-cut'), alias: 'tester', rating: null });
    expect(report.accepted).toEqual([]);
    expect(report.skipped).toHaveLength(1);
    expect(report.skipped[0]?.reason).toBe('обрыв');
    expect(report.alias).toBe('tester');
  }, 120_000);

  it('партия другого режима отбраковывается как «не Battlegrounds», а не как обрыв', async () => {
    // Первый архив игрока: сессия из четырёх партий Standard (GT_RANKED).
    const ranked = [
      'D 03:14:25.0518293 GameState.DebugPrintPower() - CREATE_GAME',
      'D 03:14:25.0518293 GameState.DebugPrintPower() -     GameEntity EntityID=1',
      'D 03:14:25.0518293 GameState.DebugPrintGame() - GameType=GT_RANKED',
      'D 03:14:25.0518293 GameState.DebugPrintGame() - FormatType=FT_STANDARD',
    ].join('\r\n');
    expect(gameTypeOf(ranked)).toBe('GT_RANKED');
    expect(gameTypeOf(text)).toBe('GT_BATTLEGROUNDS');
    expect(gameTypeOf('без строки режима')).toBeNull();

    const tar = await makeArchive('hsbg-logs_ranked.tar', ranked, null);
    const report = importArchive(tar, { datasetDir: join(dir, 'dataset-ranked'), contribDir: join(dir, 'contrib-ranked'), alias: 'tester' });
    expect(report.accepted).toEqual([]);
    expect(report.skipped).toEqual([
      { session: SESSION, index: 1, reason: 'не Battlegrounds', detail: 'GT_RANKED' },
    ]);
  });

  it('--own: свои партии ложатся без пометки исполнителя', async () => {
    const datasetDir = join(dir, 'dataset-own');
    const contribDir = join(dir, 'contrib-own');
    const tar = await makeArchive('hsbg-logs_own.tar', text, false);
    const report = importArchive(tar, { datasetDir, contribDir, own: true, rating: 9000 });

    expect(report.alias).toBe('own');
    expect(report.accepted[0]?.fileName).toBe('own_2026-08-13T20-19-19_g1_b248348_p7.json');
    const record = JSON.parse(readFileSync(join(datasetDir, report.accepted[0]?.fileName ?? ''), 'utf8')) as DatasetRecord;
    expect(record.contributor).toBeUndefined();
    expect(record.contributorRating).toBeUndefined();
    expect(record.overlay).toBe(false);
    expect(report.rawDir).toBe(join(contribDir, 'own', 'hsbg-logs_own'));
  }, 120_000);

  it('запись импорта — то же, что записал бы живой путь оверлея, во всём, на чём учится модель', async () => {
    // Живой путь: порции байтов → строки → GameFeed → DatasetRecorder,
    // как в оверлее (порция 4 КБ — обычный опрос, не догон целиком).
    const saved: DatasetRecord[] = [];
    const recorder = new DatasetRecorder({
      dir: 'unused',
      save: (_name, record) => {
        saved.push(record);
      },
    });
    const lines = new LineAssembler();
    const feed = new GameFeed();
    const bytes = Buffer.from(text, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += 4096) {
      feed.pushLines(lines.push(bytes.subarray(offset, Math.min(bytes.length, offset + 4096))));
      const state = feed.snapshot();
      if (state !== null) recorder.update(state);
    }
    const live = saved[0];
    expect(live).toBeDefined();

    // Пакетный путь — тот самый импорт.
    const datasetDir = join(dir, 'dataset-live');
    const tar = await makeArchive('hsbg-logs_live.tar', text, null);
    const report = importArchive(tar, { datasetDir, contribDir: join(dir, 'contrib-live'), alias: 'tester' });
    const imported = JSON.parse(readFileSync(join(datasetDir, report.accepted[0]?.fileName ?? ''), 'utf8')) as DatasetRecord;

    // Паспорт партии и журнал действий — побайтно.
    expect(imported.finalPlace).toBe(live?.finalPlace);
    expect(imported.heroCardId).toBe(live?.heroCardId);
    expect(imported.buildNumber).toBe(live?.buildNumber);
    expect(imported.actions).toEqual(live?.actions);

    // Точки решения: те же ходы, и на каждой — своё положение.
    // Целиком состояния НЕ равны, и это известно (docs/collector.md):
    // пакетный снимок берётся на последнем ZONE/RESOURCES-событии до траты,
    // живой — на конце порции, то есть на несколько событий позже. Разница
    // не только в служебных тегах: на part7 в одной точке из девяти атака
    // миньона борда 44 против 48 — усиление пришло тегом ATK после
    // последнего снимка пакетного пути. Поэтому статы борда здесь
    // не сравниваются; состав борда, рука, витрина, золото, тир, hp,
    // место и число живых обязаны совпадать.
    const own = (r: DatasetRecord) =>
      r.checkpoints.map((c) => ({
        turn: c.turn,
        gold: c.state.gold,
        goldTotal: c.state.goldTotal,
        techLevel: c.state.techLevel,
        hp: (c.state.hero?.health ?? 0) - (c.state.hero?.damage ?? 0) + (c.state.hero?.armor ?? 0),
        board: c.state.board.map((m) => m.cardId),
        hand: c.state.hand.map((m) => m.cardId),
        shop: c.state.shop.map((m) => m.cardId).sort(),
        place: c.state.finalPlace,
        alive: Object.values(c.state.lobby).filter((p) => p.place === null || p.place <= 0).length,
      }));
    expect(own(imported)).toEqual(own(live as DatasetRecord));

    // Сумма статов борда — с оговоркой выше: расходится не больше чем
    // в одной точке и не больше чем на одно усиление.
    const stats = (r: DatasetRecord) =>
      r.checkpoints.map((c) => c.state.board.reduce((s, m) => s + m.attack + m.health, 0));
    const differing = stats(imported).filter((s, i) => s !== stats(live as DatasetRecord)[i]);
    expect(differing.length).toBeLessThanOrEqual(1);
  }, 120_000);

  it('чужой файл не принимается за архив', async () => {
    const path = join(dir, 'other.tar');
    await writeTar(path, [{ name: 'readme.txt', data: Buffer.from('x') }]);
    expect(() => importArchive(path, { datasetDir: join(dir, 'x'), contribDir: join(dir, 'y') })).toThrow(/manifest/);
    writeFileSync(path, '');
  });
});
