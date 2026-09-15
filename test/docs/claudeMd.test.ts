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
 * Поэтому проверок три, и все про форму, а не про содержание:
 * - размер в пределах бюджета (при переносе — 66 КБ; бюджет с запасом
 *   на правила и индекс новых решений, двигать его вниз, а не вверх);
 * - датированных записей журнала здесь нет — они живут в docs/journal.md;
 * - индекс решений и docs/decisions.md называют одни и те же номера,
 *   а ссылки на журнал ведут на существующие якоря.
 */

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const claude = read('../../CLAUDE.md');
const decisions = read('../../docs/decisions.md');
const journal = read('../../docs/journal.md');

const BUDGET_BYTES = 100_000;

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

  it('индекс решений и docs/decisions.md называют одни и те же номера', () => {
    const indexed = [...claude.matchAll(/\]\(docs\/decisions\.md#(d\d{3})\)/g)].map((m) => m[1]);
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
