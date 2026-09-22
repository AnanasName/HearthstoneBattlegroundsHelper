import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md не разрастается обратно.
 *
 * Файл грузится в контекст КАЖДОЙ сессии целиком. К 15.09.2026 он весил
 * 501 КБ — около ста тысяч токенов, половина окна до первого слова
 * пользователя, — и 94 % в нём были журнал партий и справочник решений,
 * а не инструкции. Журнал уже переносили в docs/journal.md 02.09, и за пять
 * дней CLAUDE.md снова набрал 200 КБ: правило без проверки держится ровно
 * до следующей партии.
 *
 * 22.09.2026 из файла уехал и индекс решений: 275 строк, 54 КБ из 83 КБ —
 * две трети контекста каждой сессии И каждого субагента уходили на список,
 * который нужен раз в разбор. Он живёт в docs/decisions-index.md, и сверка
 * номеров переехала туда же: иначе новые решения перестали бы проверяться
 * вовсе.
 *
 * Поэтому проверок пять, и все про форму, а не про содержание:
 * - размер в пределах бюджета (после выноса индекса — 29 КБ; бюджет
 *   с запасом на правила, двигать его вниз, а не вверх);
 * - датированных записей журнала здесь нет — они живут в docs/journal.md;
 * - строк индекса решений здесь нет — они живут в docs/decisions-index.md;
 * - индекс решений и docs/decisions.md называют одни и те же номера;
 * - ссылки на журнал ведут на существующие якоря.
 */

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const claude = read('../../CLAUDE.md');
const decisions = read('../../docs/decisions.md');
const decisionsIndex = read('../../docs/decisions-index.md');
const journal = read('../../docs/journal.md');

const BUDGET_BYTES = 40_000;

describe('CLAUDE.md держит форму', () => {
  it(`весит меньше ${String(BUDGET_BYTES / 1000)} КБ`, () => {
    expect(Buffer.byteLength(claude, 'utf8')).toBeLessThan(BUDGET_BYTES);
  });

  it('датированные записи журнала живут в docs/journal.md, а не здесь', () => {
    const dated = claude
      .split(/\r?\n/)
      .filter((line) => /^(\d{2}\.\d{2}(,| —)|(Утром|Днём|Вечером|Ночью|Поздним вечером) \d{2}\.\d{2})/.test(line));
    expect(dated).toEqual([]);
  });

  it('строки индекса решений живут в docs/decisions-index.md, а не здесь', () => {
    const entries = claude.split(/\r?\n/).filter((line) => /^- \[D\d{3}\]/.test(line));
    expect(entries).toEqual([]);
  });

  it('индекс решений и docs/decisions.md называют одни и те же номера', () => {
    const indexed = [...decisionsIndex.matchAll(/\]\(decisions\.md#(d\d{3})\)/g)].map((m) => m[1]);
    const anchored = [...decisions.matchAll(/<a id="(d\d{3})"><\/a>/g)].map((m) => m[1]);
    expect(new Set(indexed).size).toBe(indexed.length);
    expect(new Set(anchored).size).toBe(anchored.length);
    expect([...indexed].sort()).toEqual([...anchored].sort());
  });

  it('ссылки на журнал ведут на существующие записи', () => {
    const linked = [...claude.matchAll(/\]\(docs\/journal\.md#(j-[\w-]+)\)/g)].map((m) => m[1]);
    const anchors = new Set([...journal.matchAll(/<a id="(j-[\w-]+)"><\/a>/g)].map((m) => m[1]));
    expect(linked.length).toBeGreaterThan(0);
    expect(linked.filter((id) => !anchors.has(id ?? ''))).toEqual([]);
  });
});
