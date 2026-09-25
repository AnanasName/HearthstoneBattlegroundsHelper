import type {
  BattleFact,
  BattleRecount,
  Finding,
  FindingClass,
  PostGameReport,
  TurnRow,
} from './types.js';
import { plural } from './words.js';

/**
 * Отчёт и индекс партий — самодостаточным HTML.
 *
 * Без сети (правило проекта: никаких запросов в рантайме): стили
 * встроены, картинок карт нет, шрифт системный. Файл открывается
 * браузером по умолчанию из трея — окно игры он не трогает и фокус
 * не забирает (оверлей сквозной и фокус брать не может, D285).
 *
 * Весь текст проходит через `esc`: в отчёте имена карт и строки лога,
 * а в логе встречаются угловые скобки (`[entityName=…]`).
 */

export const CLASS_LABEL: Readonly<Record<FindingClass, string>> = {
  missedTriple: 'Тройка',
  burnedGold: 'Золото',
  idlePower: 'Сила героя',
  unplacedMinion: 'Слот',
  positioning: 'Расстановка',
  planVsPlayer: 'План',
};

const CLASS_ORDER: readonly FindingClass[] = [
  'missedTriple',
  'burnedGold',
  'idlePower',
  'unplacedMinion',
  'positioning',
  'planVsPlayer',
];

export function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pct = (n: number): string => `${n.toFixed(1)} %`;

/** ISO-время сборки — местными часами машины, где отчёт собран и читается. */
function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
const signed = (n: number, digits = 1): string => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n).toFixed(digits)}`;

function outcomeWord(b: BattleFact): string {
  if (b.outcome === 'won') return 'выигран';
  if (b.outcome === 'tied') return 'ничья';
  return `проигран, −${String(b.damageTaken)} hp`;
}

const STYLE = `
:root {
  --bg: #f6f5f2; --panel: #ffffff; --ink: #1d1d1f; --muted: #6b6b70; --line: #e3e1dc;
  --fact: #b3261e; --fact-bg: #fcebea; --guess: #8a5a00; --guess-bg: #fff4dc;
  --good: #1f7a3a; --good-bg: #e7f5ec; --chip: #efeee9; --accent: #2f5bd3;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141416; --panel: #1d1d20; --ink: #ececef; --muted: #9a9aa2; --line: #2e2e33;
    --fact: #ff8a80; --fact-bg: #3a1f1d; --guess: #ffcc66; --guess-bg: #362a12;
    --good: #7fd69a; --good-bg: #16301f; --chip: #2a2a2f; --accent: #8fb0ff;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
.sub { color: var(--muted); margin: 0 0 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; }
.chip { background: var(--chip); border-radius: 999px; padding: 4px 12px; font-size: 13px; }
.chip b { font-weight: 600; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; margin: 0 0 12px; }
.card.fact { border-left: 4px solid var(--fact); }
.card.assumption { border-left: 4px solid var(--guess); }
.meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
.tag { border-radius: 6px; padding: 1px 8px; font-weight: 600; font-size: 12px; }
.tag.fact { background: var(--fact-bg); color: var(--fact); }
.tag.assumption { background: var(--guess-bg); color: var(--guess); }
.title { font-weight: 600; margin: 6px 0; }
ul.details { margin: 4px 0 0; padding-left: 18px; }
ul.details li { margin: 2px 0; }
.impact { margin-top: 10px; padding: 8px 12px; border-radius: 8px; background: var(--chip); font-size: 14px; }
.impact .noise { color: var(--muted); }
.caveat { margin-top: 8px; font-size: 13px; color: var(--muted); }
.empty { color: var(--muted); font-style: italic; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line);
  border-radius: 12px; overflow: hidden; font-size: 13px; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { color: var(--muted); font-weight: 600; background: var(--chip); }
td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
tr.cut td { background: var(--fact-bg); }
td.idle.late { color: var(--fact); font-weight: 600; }
.warn { color: var(--guess); }
.lost { color: var(--fact); }
.won { color: var(--good); }
.mark { display: inline-block; border-radius: 6px; padding: 0 6px; margin: 0 2px 2px 0; font-size: 12px;
  background: var(--fact-bg); color: var(--fact); }
.mark.assumption { background: var(--guess-bg); color: var(--guess); }
.scroll { overflow-x: auto; }
a { color: var(--accent); }
footer { margin-top: 32px; color: var(--muted); font-size: 13px; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

function impactHtml(impact: BattleRecount): string {
  const d = impact.alternative.scorePct - impact.played.scorePct;
  const dmg = impact.played.expectedDamage - impact.alternative.expectedDamage;
  const noise = impact.distinguishable ? '' : ' <span class="noise">(разница в пределах шума)</span>';
  return `<div class="impact">В бою после хода ${esc(impact.against)}: победы с половиной ничьих ${pct(impact.played.scorePct)} → ${pct(impact.alternative.scorePct)} (${signed(d)} п.п.), ожидаемый урон по герою ${impact.played.expectedDamage.toFixed(1)} → ${impact.alternative.expectedDamage.toFixed(1)} hp (${signed(-dmg)})${noise}${impact.singleOpponent ? ' <span class="noise">— урон против одного соперника: оценка, не калиброванное число (D283)</span>' : ''}</div>`;
}

function findingHtml(f: Finding): string {
  const kindWord = f.kind === 'fact' ? 'факт' : 'предположение';
  const when = [`ход таверны ${String(f.tavernTurn)}`, f.time === null ? null : f.time]
    .filter((x): x is string => x !== null)
    .join(' · ');
  const details = f.details.length === 0 ? '' : `<ul class="details">${f.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`;
  const impact =
    f.impact !== null
      ? impactHtml(f.impact)
      : f.impactNote === null
        ? ''
        : `<div class="impact">${esc(f.impactNote)}</div>`;
  const battle =
    f.nextBattle === null
      ? ''
      : `<div class="caveat">На деле бой после хода ${esc(outcomeWord(f.nextBattle))}.</div>`;
  const caveats = f.caveats.map((c) => `<div class="caveat">${esc(c)}</div>`).join('');
  return `<article class="card ${f.kind}">
<div class="meta"><span class="tag ${f.kind}">${kindWord}</span><span>${esc(CLASS_LABEL[f.klass])}</span><span>${esc(when)}</span></div>
<div class="title">${esc(f.title)}</div>
${details}${impact}${battle}${caveats}
</article>`;
}

function actionsCell(row: TurnRow): string {
  const a = row.actions;
  const parts: string[] = [];
  if (a.buy > 0) parts.push(`купил ${String(a.buy)}`);
  if (a.sell > 0) parts.push(`продал ${String(a.sell)}`);
  if (a.roll > 0) parts.push(`обновил ${String(a.roll)}`);
  if (a.play > 0) parts.push(`разыграл ${String(a.play)}`);
  if (a.levelUp > 0) parts.push('подъём');
  if (a.freeze > 0) parts.push('заморозка');
  if (a.heroPower > 0) parts.push(`сила ${String(a.heroPower)}`);
  if (a.other > 0) parts.push(`прочее ${String(a.other)}`);
  return parts.length === 0 ? '—' : parts.join(', ');
}

function marksCell(row: TurnRow, report: PostGameReport): string {
  const kinds = new Map<FindingClass, 'fact' | 'assumption'>();
  for (const f of [...report.facts, ...report.assumptions]) {
    if (f.turn !== row.turn) continue;
    if (kinds.get(f.klass) !== 'fact') kinds.set(f.klass, f.kind);
  }
  return [...kinds.entries()]
    .map(([k, kind]) => `<span class="mark ${kind}">${esc(CLASS_LABEL[k])}</span>`)
    .join('');
}

function timelineHtml(report: PostGameReport): string {
  const rows = report.turns
    .map((row) => {
      const battle =
        row.battle === null
          ? '—'
          : `<span class="${row.battle.outcome === 'lost' ? 'lost' : row.battle.outcome === 'won' ? 'won' : ''}">${esc(outcomeWord(row.battle))}</span>`;
      const idle = row.idleSeconds === null ? '—' : `${row.idleSeconds.toFixed(1)} с`;
      const length = row.turnSeconds === null ? '—' : `${row.turnSeconds.toFixed(0)} с`;
      return `<tr class="${row.cutByTimer ? 'cut' : ''}">
<td class="num">${String(row.tavernTurn)}</td><td class="num">${String(row.tier)}</td><td class="num">${String(row.hp)}</td>
<td class="num">${String(row.goldLeft)} / ${String(row.goldTotal)}</td><td>${esc(actionsCell(row))}</td>
<td class="num">${String(row.clicks)}</td><td class="num">${length}</td><td class="num idle${row.lateAction ? ' late' : ''}">${idle}${row.cutByTimer ? ' · оборван' : ''}</td>
<td>${battle}</td><td>${marksCell(row, report)}</td></tr>`;
    })
    .join('\n');
  return `<div class="scroll"><table>
<thead><tr><th>Ход</th><th>Тир</th><th>HP</th><th>Золото осталось</th><th>Действия</th><th>Нажатий</th><th>Длина хода</th><th>Пауза до конца</th><th>Бой после</th><th>Пункты</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`;
}

function countByClass(findings: readonly Finding[]): string {
  const counts = new Map<FindingClass, number>();
  for (const f of findings) counts.set(f.klass, (counts.get(f.klass) ?? 0) + 1);
  return CLASS_ORDER.filter((k) => counts.has(k))
    .map((k) => `${CLASS_LABEL[k]} ${String(counts.get(k))}`)
    .join(', ');
}

/**
 * Итог сравнения с планом одной строкой. Ходы, где стол игрока сильнее
 * плана, пунктами не печатаются (в отчёте об ошибках это шум), но число
 * их стоит на виду: советник — не судья (deferred.md, «Ход игрока против
 * хода советника»), и отчёт не должен выглядеть так, будто он всегда прав.
 */
function planTallyHtml(report: PostGameReport): string {
  const t = report.planTally;
  if (t.compared === 0) return '';
  return `<p class="sub">План советника сравнён с вашим ходом на ${plural(t.compared, 'ходе', 'ходах', 'ходах')}: совпал — ${String(t.same)}, разница в пределах шума — ${String(t.withinNoise)}, ваш стол сильнее — ${String(t.playerStronger)}, план сильнее — ${String(t.planStronger)}${t.planStronger > 0 ? ' (ниже)' : ''}.</p>`;
}

/** Оговорки ко всему отчёту: неполная партия, поле бордов не той игры. */
function headerNotes(report: PostGameReport): string {
  const notes: string[] = [];
  if (report.game.partial) {
    const from = report.game.firstTavernTurn;
    notes.push(
      from !== null && from > 1
        ? `Партия неполная: разбор начинается с хода таверны ${String(from)} (переподключение) — то, что было раньше, в отчёт не вошло.`
        : 'Партия неполная (переподключение или не доиграна): ход на шве может дать ложный пункт.',
    );
  }
  const a = report.analysis;
  if (a.fieldBuiltAt !== null && !a.fieldFitsGame && (a.sections.positioning || a.sections.plan)) {
    notes.push(
      `Поле бордов собрано ${a.fieldBuiltAt.slice(0, 10)} на билде ${String(a.fieldBuild)}, а партия — на ${String(report.game.buildNumber)}: пул карт другой, поэтому расстановка здесь бывает только предположением.`,
    );
  }
  return notes.map((n) => `<p class="sub warn">${esc(n)}</p>`).join('\n');
}

export function reportTitle(report: PostGameReport): string {
  const hero = report.game.heroName ?? 'герой неизвестен';
  const place = report.game.place === null ? 'не доиграна' : `${String(report.game.place)} место`;
  return `Разбор партии: ${hero}, ${place}`;
}

export function renderReportHtml(report: PostGameReport): string {
  const g = report.game;
  const when = [g.date, g.startedAt === null ? null : `${g.startedAt}–${g.endedAt ?? '?'}`]
    .filter((x): x is string => x !== null)
    .join(' ');
  const cutTurns = report.turns.filter((t) => t.cutByTimer).length;
  const lateTurns = report.turns.filter((t) => t.lateAction).length;
  const hpLost = report.turns.reduce((sum, t) => sum + (t.battle?.damageTaken ?? 0), 0);
  const chips = [
    `<span class="chip">фактов <b>${String(report.facts.length)}</b></span>`,
    `<span class="chip">предположений <b>${String(report.assumptions.length)}</b></span>`,
    `<span class="chip">действие в последние 5 с — <b>${String(lateTurns)}</b> из ${String(report.turns.length)} ходов</span>`,
    `<span class="chip">оборвано таймером <b>${String(cutTurns)}</b></span>`,
    `<span class="chip">потеряно в боях <b>${String(hpLost)}</b> hp</span>`,
  ].join('');

  const facts =
    report.facts.length === 0
      ? '<p class="empty">Однозначных ошибок прибор не нашёл. Это не «сыграно идеально»: чего он не судит — ниже.</p>'
      : report.facts.map(findingHtml).join('\n');
  const { sections } = report.analysis;
  const notComputed = [!sections.positioning ? 'расстановка' : null, !sections.plan ? 'план советника' : null].filter(
    (x): x is string => x !== null,
  );
  const fastNote =
    notComputed.length === 0
      ? ''
      : `<p class="sub warn">Быстрый разбор: ${esc(notComputed.join(' и '))} не считались — их пунктов здесь нет не потому, что всё чисто.</p>`;
  const assumptions =
    report.assumptions.length === 0
      ? '<p class="empty">Предположений нет.</p>'
      : report.assumptions.map(findingHtml).join('\n');
  const notJudged = report.notJudged
    .map((n) => `<li><b>${esc(n.what)}</b> — ${esc(n.reason)}</li>`)
    .join('');
  const skipped =
    report.skipped.length === 0
      ? ''
      : `<h2>Где прибор промолчал</h2><ul class="details">${report.skipped
          .map((s) => `<li>${esc(s.what)}: ${esc(s.reason)} — ${String(s.count)}</li>`)
          .join('')}</ul>`;

  const body = `
<h1>${esc(reportTitle(report))}</h1>
<p class="sub">${esc(when)}${g.buildNumber === null ? '' : ` · билд ${String(g.buildNumber)}`} · ходов таверны ${String(g.tavernTurns)} · ${esc(report.source.ref)}</p>
<div class="chips">${chips}</div>
${headerNotes(report)}

<h2>Факты</h2>
<p class="sub">Что было видно в момент хода и не зависит от советника: правило игры или расстановка, проигрывающая полю бордов этого хода. Фактический соперник и исход боя — только в графе цены.${report.facts.length === 0 ? '' : ` ${esc(countByClass(report.facts))}.`}</p>
${facts}

<h2>Предположения</h2>
<p class="sub">Сравнение с планом советника и с бордом соперника, которого в таверне видно не было. Это числа о ближайшем бое, а не приговор: темп, экономику и карты в руке они не видят.</p>
${fastNote}
${planTallyHtml(report)}
${assumptions}

<h2>Лента партии</h2>
<p class="sub">Ход таверны — как в игре. Длина хода — время, доступное вам: без показа прошлого боя. Пауза до конца — от последнего действия; красным — действие в последние 5 с, строка с заливкой — последнее нажатие не успело исполниться (ход оборвал таймер).</p>
${timelineHtml(report)}

<h2>Чего отчёт не судит</h2>
<ul class="details">${notJudged}</ul>
${skipped}

<footer>Собрано ${esc(localTime(report.generatedAt))}${report.analysis.appVersion === null ? '' : ` · версия ${esc(report.analysis.appVersion)}`}${report.analysis.simulatorVersion === null ? '' : ` · симулятор ${esc(report.analysis.simulatorVersion)}`} · ${(report.elapsedMs / 1000).toFixed(0)} с. Проценты боя — победы плюс половина ничьих. Советы и пороги — текущей версии приложения: после её обновления отчёт по той же партии может измениться.</footer>
`;
  return page(reportTitle(report), body);
}

/** Строка индекса: отчёт и имя его файла рядом с индексом. */
export interface IndexEntry {
  readonly file: string;
  readonly report: PostGameReport;
}

export function renderIndexHtml(entries: readonly IndexEntry[]): string {
  // Сводка «в скольких партиях повторяется» — только по полным партиям:
  // кусок после переподключения посчитал бы одну партию дважды.
  const whole = entries.filter((e) => !e.report.game.partial);
  const games = whole.length;
  const perClass = CLASS_ORDER.map((k) => {
    const withIt = whole.filter((e) => e.report.facts.some((f) => f.klass === k)).length;
    const total = whole.reduce((sum, e) => sum + e.report.facts.filter((f) => f.klass === k).length, 0);
    return { k, withIt, total };
  }).filter((c) => c.total > 0);

  const summary =
    perClass.length === 0
      ? '<p class="empty">Фактов пока нет ни в одной партии.</p>'
      : `<div class="chips">${perClass
          .map(
            (c) =>
              `<span class="chip">${esc(CLASS_LABEL[c.k])}: <b>${String(c.total)}</b> в ${String(c.withIt)} из ${String(games)} партий</span>`,
          )
          .join('')}</div>`;

  const rows = entries
    .map((e) => {
      const g = e.report.game;
      const when = [g.date, g.startedAt].filter((x): x is string => x !== null).join(' ');
      const marks = [
        g.partial ? 'неполная' : null,
        e.report.analysis.sections.positioning && e.report.analysis.sections.plan ? null : 'быстрый разбор',
      ].filter((x): x is string => x !== null);
      const mark = marks.length === 0 ? '' : ` <span class="noise">(${esc(marks.join(', '))})</span>`;
      return `<tr><td>${esc(when)}</td><td><a href="${esc(encodeURI(e.file))}">${esc(g.heroName ?? '—')}</a>${mark}</td>
<td class="num">${g.place === null ? '—' : String(g.place)}</td>
<td class="num">${String(e.report.facts.length)}</td><td>${esc(countByClass(e.report.facts)) || '—'}</td>
<td class="num">${String(e.report.assumptions.length)}</td><td class="num">${String(e.report.turns.filter((t) => t.cutByTimer).length)}</td><td>${esc(e.report.analysis.appVersion ?? '—')}</td></tr>`;
    })
    .join('\n');

  const body = `
<h1>Разборы партий</h1>
<p class="sub">Партий ${String(games)}${entries.length > games ? ` и неполных ${String(entries.length - games)} (в сводку не входят)` : ''}. Сверху — какие однозначные ошибки повторяются.</p>
${summary}
<h2>Партии</h2>
<div class="scroll"><table>
<thead><tr><th>Когда</th><th>Герой</th><th>Место</th><th>Фактов</th><th>Какие</th><th>Предположений</th><th>Оборвано таймером</th><th>Версия</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>
<footer>Факт — ошибка, видная в момент хода и не зависящая от советника. Предположение — число о ближайшем бое, не приговор.</footer>
`;
  return page('Разборы партий', body);
}
