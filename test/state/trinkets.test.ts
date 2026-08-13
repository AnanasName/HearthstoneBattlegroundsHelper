import { beforeAll, describe, expect, it } from 'vitest';

import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part6Game } from '../fixtures.js';

/**
 * Тринкеты из настоящего лога (part6, билд 248348).
 *
 * Два разных факта, и оба нужны советникам:
 *
 *  - ПРЕДЛОЖЕНИЕ — сущности `CARDTYPE=BATTLEGROUND_TRINKET` в `SETASIDE`
 *    с `USE_DISCOVER_VISUALS=1`; после выбора клиент обнуляет тег,
 *    и предложение исчезает из состояния;
 *  - ВЗЯТОЕ — теги `BACON_FIRST/SECOND_TRINKET_DATABASE_ID` на героях,
 *    причём у всех восьми игроков, а не только у себя.
 *
 * Контрольные значения сверены с логом руками: свой игрок (PlayerID 6)
 * выбирал из четырёх вариантов и взял dbfId 130980 — Cowrie Necklace.
 */
describe('тринкеты в состоянии партии', () => {
  let text: string;
  let finalState: GameState;

  beforeAll(() => {
    text = part6Game();
    finalState = reduceLog(text);
  }, 120_000);

  it('открытое предложение видно, пока выбор не сделан', () => {
    // Момент между показом вариантов и выбором: свой герой получает тег
    // BACON_FIRST_TRINKET_DATABASE_ID со значением 130980 ровно в момент
    // выбора — берём лог до этой строки.
    const pickAt = text.indexOf('tag=BACON_FIRST_TRINKET_DATABASE_ID value=130980');
    expect(pickAt).toBeGreaterThan(0);
    const before = text.slice(0, text.lastIndexOf('\n', pickAt));

    const reducer = createReducer(readPlayers(before));
    for (const event of readPowerEvents(before)) reducer.step(event);
    const state = reducer.snapshot();

    const offered = state.trinketOffer.map((o) => o.cardId);
    expect(offered).toContain('BG30_MagicItem_425');
    expect(offered).toContain('BG35_MagicItem_921');
    expect(offered.length).toBeGreaterThanOrEqual(3);
  });

  it('после выбора предложение из состояния исчезает', () => {
    expect(finalState.trinketOffer).toEqual([]);
  });

  it('взятый тринкет виден у себя, и не только первый', () => {
    const own = finalState.trinketsByPlayer[finalState.playerId ?? -1] ?? [];
    // 130980 — Cowrie Necklace, выбор сверен с логом руками.
    expect(own).toContain(130980);
    expect(own.length).toBeGreaterThanOrEqual(2);
  });

  it('тринкеты противников тоже известны — их можно отдавать симулятору', () => {
    const players = Object.keys(finalState.trinketsByPlayer);
    // К концу партии тринкеты есть у большинства из восьми игроков.
    expect(players.length).toBeGreaterThanOrEqual(6);
  });
});
