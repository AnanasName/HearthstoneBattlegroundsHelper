import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DROPPED_FIELDS, serializeSnapshot, trimSnapshot } from '../../src/data/cardsSnapshot.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

describe('обрезка снапшота карт', () => {
  it('убирает перечисленные поля и не трогает остальные', () => {
    const card = {
      id: 'BG25_011',
      name: 'Eternal Knight',
      audio2: { play: ['звук.ogg'] },
      techLevel: 2,
      flavor: 'шутка',
      races: ['UNDEAD'],
    };
    expect(trimSnapshot([card])).toEqual([
      { id: 'BG25_011', name: 'Eternal Knight', techLevel: 2, races: ['UNDEAD'] },
    ]);
  });

  it('сохраняет ПОРЯДОК оставшихся полей — снапшот лежит в git и читается диффом', () => {
    const card = { id: 'a', audio2: 1, name: 'b', flavor: 2, techLevel: 3 };
    expect(Object.keys(trimSnapshot([card])[0] as object)).toEqual(['id', 'name', 'techLevel']);
  });

  it('не спотыкается о карту, которой нет', () => {
    expect(trimSnapshot([null, 5, 'строка'])).toEqual([null, 5, 'строка']);
  });

  it('на диск пишет без отступов: они и есть половина веса файла', () => {
    const text = serializeSnapshot([{ id: 'a', name: 'b' }]);
    expect(text).toBe('[{"id":"a","name":"b"}]');
  });
});

/**
 * Сторож списка.
 *
 * Обрезка тем и опасна, что её ошибка не роняет прогон, а тихо меняет исход
 * симуляции. Список выброшенных полей посчитан по коду один раз; обновление
 * `@firestone-hs/simulate-bgs-battle` может начать читать любое из них,
 * и тогда снапшот молча окажется неполным. Поэтому список пересчитывается
 * при каждом прогоне тестов.
 *
 * Скан дешёвый: 945 файлов `.js` у firestone — 4.2 МБ, около 0.1 с.
 */
function sourceFiles(): string[] {
  const found: string[] = [];

  const walk = (dir: string, keep: (name: string) => boolean): void => {
    let entries;
    try {
      entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path, keep);
      else if (keep(entry.name)) found.push(path);
    }
  };

  // Исполняемый код: скомпилированный симулятор и наши исходники.
  // `.d.ts` пропускаются намеренно — объявление поля чтением не является.
  walk('node_modules/@firestone-hs', (n) => n.endsWith('.js'));
  walk('src', (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'));

  // Файл, который список объявляет, и этот тест — в них имена полей стоят
  // как данные, а не как чтение снапшота.
  return found.filter((p) => !p.endsWith('src/data/cardsSnapshot.ts'));
}

describe('список выброшенных полей остаётся верным', () => {
  const files = sourceFiles();

  it('находит исходники, по которым судит', () => {
    // Пустой список означал бы, что сторож молча ничего не проверяет.
    expect(files.length).toBeGreaterThan(500);
  });

  it.each(DROPPED_FIELDS)('поле %s не читает никто', (field) => {
    const re = new RegExp(`\\b${field}\\b`);
    const users = files.filter((path) => re.test(readFileSync(join(ROOT, path), 'utf8')));
    expect(users, `поле ${field} снова кому-то нужно — убрать его из DROPPED_FIELDS`).toEqual([]);
  });
});
