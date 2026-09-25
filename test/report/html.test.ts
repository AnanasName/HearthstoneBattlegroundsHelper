import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { esc, renderIndexHtml, renderReportHtml } from '../../src/report/html.js';
import { readReports, reportFileBase, writeReport } from '../../src/report/store.js';
import { REPORT_SCHEMA, type Finding, type PostGameReport, type TurnRow } from '../../src/report/types.js';

const row = (turn: number, over: Partial<TurnRow> = {}): TurnRow => ({
  turn,
  tavernTurn: (turn + 1) / 2,
  tier: 3,
  hp: 30,
  goldTotal: 7,
  goldLeft: 0,
  boardSize: 5,
  actions: { buy: 2, sell: 1, roll: 1, levelUp: 0, freeze: 0, play: 2, heroPower: 0, other: 0 },
  clicks: 9,
  turnSeconds: 80,
  idleSeconds: 20,
  lateAction: false,
  cutByTimer: false,
  battle: { turn: turn + 1, outcome: 'lost', damageTaken: 6 },
  marks: [],
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  kind: 'fact',
  klass: 'burnedGold',
  turn: 19,
  tavernTurn: 10,
  time: '21:34:22',
  title: 'Сгорело 5 золота при доступной покупке',
  details: ['в витрине по карману: <Fire Baller> за 3'],
  impact: {
    against: 'против фактического соперника',
    played: { scorePct: 40, winPct: 38, tiePct: 4, lossPct: 58, expectedDamage: 5.2, sims: 4000 },
    alternative: { scorePct: 55, winPct: 53, tiePct: 4, lossPct: 43, expectedDamage: 3.9, sims: 4000 },
    distinguishable: true,
    singleOpponent: true,
  },
  impactNote: null,
  nextBattle: { turn: 20, outcome: 'tied', damageTaken: 0 },
  caveats: [],
  ...over,
});

const report = (over: Partial<PostGameReport> = {}): PostGameReport => ({
  schema: REPORT_SCHEMA,
  generatedAt: '2026-09-25T02:00:00.000Z',
  source: { ref: 'part68', gameIndex: null },
  game: {
    heroCardId: 'BG20_HERO_201',
    heroName: "Vol'jin",
    place: 2,
    buildNumber: 251952,
    date: null,
    startedAt: '21:17:09',
    endedAt: '21:46:23',
    tavernTurns: 2,
    partial: false,
    firstTavernTurn: 9,
  },
  analysis: {
    appVersion: '0.1.1',
    simulatorVersion: '1.1.757',
    fieldBuiltAt: '2026-09-19T10:00:00.000Z',
    fieldBuild: 251952,
    fieldFitsGame: true,
    sections: { positioning: true, plan: true },
  },
  turns: [
    row(17),
    row(19, { lateAction: true, cutByTimer: true, idleSeconds: 1.7, goldLeft: 5, marks: ['burnedGold'] }),
  ],
  facts: [finding()],
  assumptions: [],
  notJudged: [{ what: 'Подъём таверны', reason: 'ближайший бой его не видит' }],
  planTally: { compared: 6, same: 2, withinNoise: 1, playerStronger: 2, planStronger: 1 },
  skipped: [{ what: 'Расстановка', reason: 'первый ход таверны', count: 1 }],
  elapsedMs: 12_000,
  ...over,
});

describe('отчёт после партии: HTML', () => {
  it('экранирует всё, что пришло из лога и справочника', () => {
    expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const html = renderReportHtml(report());
    expect(html).toContain('&lt;Fire Baller&gt;');
    expect(html).not.toContain('<Fire Baller>');
  });

  it('факт несёт ход таверны, часы, цену в бою и то, что было на деле', () => {
    const html = renderReportHtml(report());
    expect(html).toContain('ход таверны 10 · 21:34:22');
    expect(html).toContain('победы с половиной ничьих 40.0 % → 55.0 % (+15.0 п.п.)');
    expect(html).toContain('ожидаемый урон по герою 5.2 → 3.9 hp (−1.3)');
    expect(html).toContain('На деле бой после хода ничья.');
  });

  it('разница в пределах шума так и подписана', () => {
    const base = finding();
    if (base.impact === null) throw new Error('у образца есть пересчёт');
    const html = renderReportHtml(
      report({ facts: [{ ...base, impact: { ...base.impact, distinguishable: false } }] }),
    );
    expect(html).toContain('разница в пределах шума');
  });

  it('без фактов отчёт не говорит «сыграно идеально», а отсылает к тому, чего не судит', () => {
    const html = renderReportHtml(report({ facts: [] }));
    expect(html).toContain('Однозначных ошибок прибор не нашёл');
    expect(html).toContain('Подъём таверны');
  });

  it('ходы, где стол игрока сильнее плана, видны числом, а не пропадают', () => {
    expect(renderReportHtml(report())).toContain(
      'совпал — 2, разница в пределах шума — 1, ваш стол сильнее — 2, план сильнее — 1 (ниже)',
    );
  });

  it('быстрый разбор говорит, что расстановку и план не считали, а не «предположений нет» молча', () => {
    const base = report();
    const html = renderReportHtml({ ...base, analysis: { ...base.analysis, sections: { positioning: false, plan: false } } });
    expect(html).toContain('Быстрый разбор: расстановка и план советника не считались');
    expect(renderReportHtml(base)).not.toContain('Быстрый разбор');
  });

  it('кусок после переподключения назван: с какого хода начат разбор', () => {
    const base = report();
    const html = renderReportHtml({ ...base, game: { ...base.game, partial: true, firstTavernTurn: 12 } });
    expect(html).toContain('разбор начинается с хода таверны 12');
  });

  it('проценты боя названы честно: победы с половиной ничьих', () => {
    const html = renderReportHtml(report());
    expect(html).toContain('победы с половиной ничьих 40.0 %');
    expect(html).toContain('Проценты боя — победы плюс половина ничьих');
  });

  it('урон против одного соперника подписан как оценка (D283)', () => {
    expect(renderReportHtml(report())).toContain('урон против одного соперника: оценка');
  });

  it('поле бордов чужого билда названо в шапке: расстановка тогда только предположение', () => {
    const base = report();
    const html = renderReportHtml({
      ...base,
      game: { ...base.game, buildNumber: 253216 },
      analysis: { ...base.analysis, fieldFitsGame: false },
    });
    expect(html).toContain('Поле бордов собрано 2026-09-19 на билде 251952, а партия — на 253216');
    expect(renderReportHtml(base)).not.toContain('Поле бордов собрано');
  });

  it('лента отмечает оборванный ход и значок пункта', () => {
    const html = renderReportHtml(report());
    expect(html).toMatch(/<tr class="cut">[\s\S]*?1\.7 с · оборван[\s\S]*?<span class="mark fact">Золото<\/span>/);
    expect(html).toContain('проигран, −6 hp');
  });

  it('индекс считает, в скольких партиях повторяется каждый класс фактов', () => {
    const html = renderIndexHtml([
      { file: 'part68.html', report: report() },
      { file: 'part45.html', report: report({ source: { ref: 'part45', gameIndex: null }, facts: [finding(), finding()] }) },
      { file: 'part72.html', report: report({ source: { ref: 'part72', gameIndex: null }, facts: [] }) },
    ]);
    expect(html).toContain('Золото: <b>3</b> в 2 из 3 партий');
    expect(html).toContain('href="part45.html"');
  });

  it('неполная партия в сводку повторов не входит и помечена в таблице', () => {
    const base = report();
    const html = renderIndexHtml([
      { file: 'a.html', report: base },
      { file: 'b.html', report: { ...base, game: { ...base.game, partial: true } } },
    ]);
    expect(html).toContain('Партий 1 и неполных 1 (в сводку не входят)');
    expect(html).toContain('Золото: <b>1</b> в 1 из 1 партий');
    expect(html).toContain('(неполная)');
  });
});

describe('отчёт после партии: файлы', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('имя файла — от источника: повторная сборка заменяет отчёт, а не плодит двойника', () => {
    expect(reportFileBase(report().source)).toBe('part68');
    expect(reportFileBase({ ref: 'Hearthstone_2026_09_24_19_26_35', gameIndex: 2 })).toBe(
      'Hearthstone_2026_09_24_19_26_35_g2',
    );
  });

  it('запись кладёт HTML и JSON и пересобирает индекс; чужая схема в индекс не идёт', () => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-report-'));
    writeFileSync(join(dir, 'old.json'), JSON.stringify({ schema: 0 }), 'utf8');
    // Тот же номер схемы, но без полей, которые индекс читает, — не ронять.
    writeFileSync(join(dir, 'stale.json'), JSON.stringify({ ...report(), analysis: undefined }), 'utf8');
    writeFileSync(join(dir, 'broken.json'), '{', 'utf8');
    const written = writeReport(report(), dir);
    expect(readFileSync(written.htmlPath, 'utf8')).toContain('Разбор партии: Vol&#39;jin, 2 место');
    expect(readReports(dir).map((e) => e.file)).toEqual(['part68.html']);
    expect(readFileSync(written.indexPath, 'utf8')).toContain('Партий 1.');
  });

  it('быстрый разбор пишется рядом с полным, а не поверх него', () => {
    dir = mkdtempSync(join(tmpdir(), 'hsbg-report-'));
    const base = report();
    const full = writeReport(base, dir);
    const fast = writeReport({ ...base, analysis: { ...base.analysis, sections: { positioning: false, plan: false } } }, dir);
    expect(full.htmlPath.endsWith('part68.html')).toBe(true);
    expect(fast.htmlPath.endsWith('part68_fast.html')).toBe(true);
  });
});
