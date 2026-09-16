import { beforeAll, describe, expect, it } from 'vitest';

import { minionValue } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part54Game } from '../fixtures.js';

/**
 * part54 — Инге Стальной Гимн (16.09.2026), 2-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадр игрока один: 16:24:52,
 * ход 17 — тот, на котором план звал купить Тихондрия.
 */
describe('part54: Инге, драконы и кличи через Kalecgos', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  // Лог 70 МБ: без пауз разбор держит поток воркера дольше тайм-аута RPC.
  beforeAll(async () => {
    text = part54Game();
    lines = text.split(/\r?\n/);
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(text, createBreather());
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
  }, 900_000);

  /** Состояние на момент времени — срезом лога (метод part40, part43–part53). */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(2);
    expect(turns).toHaveLength(15);
    expect(final.hero?.cardId).toBe('BG26_HERO_102');
  });

  /**
   * Кадр игрока, 16:24:52 (verifiedBy: скриншот). Золото 6 из 12 точки
   * решения — это ДВЕ траты по 3, и одной из них в журнале действий нет:
   *
   *   D 16:24:38.63… TAG_CHANGE Entity=AngryMem#2886 tag=TEMP_RESOURCES value=0
   *   D 16:24:38.63… TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES_USED value=1
   *   D 16:24:38.63… … cardId=BG26_HERO_102 …] tag=BACON_SECOND_TRINKET_DATABASE_ID value=120870
   *   D 16:24:40.37… BLOCK_START BlockType=PLAY … cardId=BG36_Button_DarkGift …
   *   D 16:24:40.37… TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES_USED value=4
   *
   * Первая — тринкет Faerie Dragon Scale за 3 (трата вне блоков, как part32),
   * вторая — тёмный дар за 3; Ignition Specialist из дара приходит в руку
   * выбором в 16:24:49.
   */
  it('кадр 16:24:52 совпадает со скриншотом', () => {
    const frame = at('16:24:52');
    expect(frame.turn).toBe(17);
    expect(frame.techLevel).toBe(5);
    expect(frame.gold).toBe(6);
    const hero = frame.hero!;
    expect((hero.health ?? 0) - hero.damage + hero.armor).toBe(27);

    const label = (list: readonly { cardId: string; attack: number | null; health: number | null }[]): string[] =>
      list.map((m) => `${cards.info(m.cardId)?.name ?? m.cardId} ${String(m.attack)}/${String(m.health)}`);
    expect(label(frame.board)).toEqual([
      'Scarlet Survivor 44/48',
      'Electric Synthesizer 21/22',
      'Thousandth Paper Drake 12/13',
      'Kalecgos, Arcane Aspect 11/19',
      'Private Investigator 5/6',
      'Prodigious Tusker 2/5',
    ]);
    expect(frame.board[0]?.divineShield).toBe(true);
    expect(label(frame.shop)).toEqual([
      'Snare Trapper 4/4',
      'Devout Hellcaller 4/4',
      'Tichondrius 4/4',
      'Prosthetic Hand 3/1',
      'Clever Castaway 2/3',
    ]);
    expect(frame.shopSpells.map((s) => cards.info(s.cardId)?.name)).toEqual(['Hired Headhunter']);
    expect(label(frame.hand)).toEqual(['Shipwrecked Rascal 5/4', 'Ignition Specialist 8/8']);
    expect(frame.handSpells.map((s) => cards.info(s.cardId)?.name)).toEqual([
      'Leaf Through the Pages',
      'Bananas',
    ]);
    expect(frame.darkGiftCharges).toBe(2);

    const taken = frame.playerId === null ? [] : (frame.trinketsByPlayer[frame.playerId] ?? []);
    expect(taken.map((dbf) => cards.infoByDbfId(dbf)?.name)).toContain('Faerie Dragon Scale');
  });

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  /**
   * Жалоба игрока №2 (кадр 16:24:52): «предлагает демона, от которого
   * не вижу смысла в этой композиции». План кадра начинался словами
   * «КУПИТЬ Tichondrius 4/4 за 3» — балл 14.0 = тир 10 + статы 4, при
   * борде из четырёх драконов, пирата и квилбоара. Текст Тихондрия
   * («After your hero takes damage, give your Demons +{0}/+{1}») на этом
   * борде обращён к пустоте, и тир за него не платит (D220). Devout
   * Hellcaller («After another friendly Demon deals damage…») — тот же
   * случай в той же витрине.
   */
  it('ход 17: Тихондрий без демонов — тело 4/4, и в плане его нет', () => {
    for (const state of [decisionPoint(17), at('16:24:52')]) {
      const tich = state.shop.find((m) => m.cardId === 'BG26_523');
      const hellcaller = state.shop.find((m) => m.cardId === 'BG33_155');
      expect(minionValue(tich!, state, { cards }).techLevel).toBe(0);
      expect(minionValue(hellcaller!, state, { cards }).techLevel).toBe(0);
      const plan = spendPlan(state, { cards });
      expect(plan.steps.some((s) => s.recommendation.minion?.cardId === 'BG26_523')).toBe(false);
    }
  });

  /**
   * Ход 27 (14-й ход таверны): шестнадцать золотых, полный борд, в плане
   * активация Hired Mount за 2 и подъём за 4. Прежде план кончался словами
   * «остаётся 10 — сгорит»: `applyRecommendation` не отмечал нажатую
   * активацию, она оставалась верхним советом, и запасное обновление
   * не наступало. Игрок потратил все шестнадцать — десятки прокруток
   * кличевых при Бранне и Kalecgos.
   */
  it('ход 27: нажатая активация не запирает обновление, золото не сгорает', () => {
    const state = decisionPoint(27);
    expect(state.gold).toBe(16);
    const plan = spendPlan(state, { cards });
    const actions = plan.steps.map((s) => s.recommendation.action);
    expect(actions.filter((a) => a === 'activate')).toHaveLength(1);
    expect(actions.at(-1)).toBe('reroll');
    expect(plan.truncated).toBe(true);
  });
});
