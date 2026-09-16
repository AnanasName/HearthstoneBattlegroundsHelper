import { createReadStream, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { loadCardIndex } from '../../src/data/cards.js';
import { raceOfSubsetTag } from '../../src/state/types.js';
import { FIXTURES_DIR } from '../fixtures.js';

/**
 * Словарь имён `BACON_SUBSET_*` на ВСЕХ фикстурах (долг part36).
 *
 * Имя в теге игры и имя племени в снапшоте совпадают не всегда
 * (`QUILLBOAR` против `QUILBOAR`, `ELEMENTALS` против `ELEMENTAL`, D108),
 * и расхождение даёт не падение, а тихо пропавшее племя тринкета.
 * Прежде словарь проверялся одной part36: считалось, что чтение всех
 * логов стоит минут. Потоковое чтение в latin1 стоит около трёх секунд
 * на 2.7 ГБ (замер 17.09) — дешевле, чем разбор одной партии.
 *
 * Имена на 17.09, part1–part55: BEAST DEMON DRAGON ELEMENTALS MECH MURLOC
 * NAGA PIRATE QUILLBOAR UNDEAD.
 */
describe('теги BACON_SUBSET_* всех фикстур называют племена снапшота', () => {
  const names = new Set<string>();

  beforeAll(async () => {
    const files = readdirSync(FIXTURES_DIR)
      .filter((d) => d.startsWith('part'))
      .flatMap((d) =>
        readdirSync(join(FIXTURES_DIR, d))
          .filter((f) => f.endsWith('.log'))
          .map((f) => join(FIXTURES_DIR, d, f)),
      );
    for (const file of files) {
      // Хвост прошлого куска — чтобы имя на стыке кусков не потерялось.
      let tail = '';
      for await (const chunk of createReadStream(file, { encoding: 'latin1', highWaterMark: 1 << 22 })) {
        const text = tail + String(chunk);
        for (const m of text.matchAll(/BACON_SUBSET_([A-Z]+)/g)) names.add(m[1] ?? '');
        tail = text.slice(-40);
      }
    }
  }, 300_000);

  it('каждое имя приводится к племени, которое снапшот знает', () => {
    const cards = loadCardIndex();
    const known = new Set<string>();
    for (const tier of [1, 2, 3, 4, 5, 6, 7]) {
      for (const info of cards.poolOfTier(tier)) for (const race of info.races) known.add(race);
    }
    // Оба известных расхождения в фикстурах есть — иначе тест ничего не значит.
    expect(names).toContain('QUILLBOAR');
    expect(names).toContain('ELEMENTALS');
    for (const name of names) expect(known, `BACON_SUBSET_${name}`).toContain(raceOfSubsetTag(name));
  });
});
