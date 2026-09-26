import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part80Game } from '../fixtures.js';

/**
 * part80 — Marin the Manager (26.09.2026), 4-е место, партия с вылета:
 * лог начинается дампом переподключения на втором ходу таверны.
 *
 * Фактура партии — в `test/fixtures.ts`. Главное здесь — тринкет,
 * взятый СИЛОЙ: игра пишет его на героя отдельным тегом
 * `BACON_HEROPOWER_TRINKET_DATABASE_ID`, и разбор, знавший только
 * FIRST/SECOND, терял его для симулятора и всех советников.
 */
describe('part80: Марин, тринкет силы героя', () => {
  let text: string;
  let final: GameState;
  let turns: TavernTurn[];

  // Лог 48 МБ: без пауз разбор держит поток воркера дольше тайм-аута RPC.
  beforeAll(async () => {
    text = part80Game();
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
    turns = await readTavernTurnsAsync(text, createBreather());
  }, 900_000);

  it('партия — хвост после переподключения: один CREATE_GAME на ходу 3, доиграна', () => {
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    // game.log:8 — дамп переподключения, а не начало партии.
    expect(text.split(/\r?\n/, 10).some((l) => l.includes('tag=TURN value=3'))).toBe(true);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(253216);
    expect(final.finalPlace).toBe(4);
    expect(final.hero?.cardId).toBe('BG30_HERO_304');
  });

  it('предложение силы на ходу таверны 5 читается как предложение тринкетов с ценами', () => {
    // До SendChoices (game.log:27936): варианты создала сила (CREATOR=227),
    // COST есть у двух — Rockin' Music Box 1 и Sunken Anchor 6 → 4
    // (game.log:23239, 23312).
    const cut = text.indexOf('GameState.SendChoices() - id=2 ');
    expect(cut).toBeGreaterThan(0);
    const state = reduceLog(text.slice(0, text.lastIndexOf('\n', cut)));
    expect(state.turn).toBe(9);
    const offer = Object.fromEntries(state.trinketOffer.map((o) => [o.cardId, o.cost]));
    expect(offer).toEqual({
      BG30_MagicItem_430: 1,
      BG35_MagicItem_850: null,
      BG30_MagicItem_544: null,
      BG35_MagicItem_890: 4,
    });
  });

  it('взятые тринкеты — все три, включая тринкет силы', () => {
    const mine = final.trinketsByPlayer[final.playerId ?? -1] ?? [];
    // 112392 Nomi Sticker — BACON_HEROPOWER_TRINKET_DATABASE_ID (game.log:27984),
    // 120800 Sellemental Portrait — FIRST (39326), 115250 Colorful Compass — SECOND (98241).
    expect([...mine].sort((a, b) => a - b)).toEqual([112392, 115250, 120800]);
  });

  it('точки решения — ходы таверны 2–13, первого нет: он прошёл до переподключения', () => {
    expect(turns.map((t) => t.turn)).toEqual([3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23, 25]);
    // Ход таверны 2: пустой борд и 4 золота — на первом ничего не куплено.
    expect(turns[0]?.state.board).toEqual([]);
    expect(turns[0]?.state.gold).toBe(4);
  });

  it('за ход до выбора силы (ход таверны 4) звучит напоминание о тринкете', () => {
    // Борд хода 7 — Dune Dweller и Risen Rider: пары одного племени нет.
    // Предложение силы пришло следующим ходом с двумя тринкетами
    // элементалей из четырёх (BACON_SUBSET_ELEMENTALS, game.log:23267, 23286).
    const cards = loadCardIndex();
    const turn7 = turns.find((t) => t.turn === 7)?.state;
    expect(turn7?.hero?.heroPowerCardId).toBe('BG30_HERO_304p');
    expect(adviseTavern(turn7!, { cards })?.trinketForecast).toContain('держите пару миньонов');
    // Ход раньше — молчит: до предложения два хода.
    const turn5 = turns.find((t) => t.turn === 5)?.state;
    expect(adviseTavern(turn5!, { cards })?.trinketForecast).toBeNull();
  });
});
