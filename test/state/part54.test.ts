import { beforeAll, describe, expect, it } from 'vitest';

import { battlecryPayoffOf, minionValue } from '../../src/advisors/tavern/advisor.js';
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
   * Жалоба игрока №1: «на 1 ходе мне советовало более слабый ход».
   * Витрина — Scarlet Survivor 3/3, Southsea Busker 3/1, Glim Guardian 1/4;
   * в руке Big Banana, сила Major Hymn. Советник звал Glim (7.0), Survivor
   * стоила 5.0 с «текст 0». Игрок купил Survivor и довёл её до 7/5 со щитом:
   *
   *   D 16:12:25.14… TAG_CHANGE Entity=[… cardId=BG35_814 …] tag=TAG_SCRIPT_DATA_NUM_1 value=6
   *   16:12:35 купил Survivor → 16:12:37 Big Banana на неё → 16:12:38, 16:12:40 Major Hymn на неё
   *
   * К ходу 3 она 7/5 (щит). Против поля первого хода: 100 % боёв против
   * 96.7 % у Glim 5/6, без щита — 90.2 % (D221).
   *
   * На ходу 9 вторая Survivor щита не получает: банан и сила уйдут своей
   * 17/19, крупнейшей на борде.
   */
  it('ход 1: Survivor добирает порог щита бананом и силой, и план берёт её', () => {
    const state = decisionPoint(1);
    const survivor = state.shop.find((m) => m.cardId === 'BG35_814');
    expect(survivor?.scriptData[0]).toBe(6);
    expect(minionValue(survivor!, state, { cards }).thresholdKeyword).toEqual({
      field: 'divineShield',
      attack: 6,
    });

    const plan = spendPlan(state, { cards });
    const first = plan.steps[0]?.recommendation;
    expect(first?.action).toBe('buy');
    expect(first?.minion?.cardId).toBe('BG35_814');
    expect(first?.reason).toContain('божественный щит');
    expect(plan.steps.slice(1).every((s) => s.recommendation.targetMinion?.cardId === 'BG35_814')).toBe(
      true,
    );

    const later = decisionPoint(9);
    const copy = later.shop.find((m) => m.cardId === 'BG35_814');
    expect(minionValue(copy!, later, { cards }).thresholdKeyword).toBeNull();
  });

  /**
   * Ход 9 (5-й ход таверны): советник звал вторую Scarlet Survivor (11.0),
   * Thousandth Paper Drake («Start of Combat: Give your left-most Dragon
   * +1/+2 and Windfury») стоил 9.5 с «текст 0, бой 0». Игрок взял Drake
   * (16:16:44), и к ходу 11 его Survivor 25/21 со щитом стоит крайней
   * левой. Против поля: 95.6 % против 93.9 % на ходу таверны 5 и 83.6 %
   * против 74.9 % на 6-м (D223).
   */
  it('ход 9: Paper Drake дарит вихрь Survivor, и план берёт его', () => {
    const state = decisionPoint(9);
    const drake = state.shop.find((m) => m.cardId === 'BG29_810');
    const grant = minionValue(drake!, state, { cards }).combatGrant;
    expect(grant?.field).toBe('windfury');
    expect(grant?.recipient.cardId).toBe('BG35_814');

    const bought = spendPlan(state, { cards })
      .steps.filter((s) => s.recommendation.action === 'buy')
      .map((s) => s.recommendation.minion?.cardId);
    expect(bought).toEqual(['BG29_810']);
  });

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
   * Шаг, который план сам отменяет продажей (D222). Ход 25: «КУПИТЬ
   * Treasure Parrot 5/5 за 3 → РАЗЫГРАТЬ Proud Privateer, продав Treasure
   * Parrot» — попугай без клича, два золотых в никуда. Ход 29: «РАЗЫГРАТЬ
   * Felfire Conjurer → РАЗЫГРАТЬ Blue Chromadrake, продав Felfire Conjurer» —
   * триггер конца хода, не доживший до конца хода. Оба плана выигрывали
   * развилку, потому что её сумма считала отменённый шаг целиком.
   * Прокрутка кличевого (купить-разыграть-продать) остаётся законной.
   */
  it('ходы 25 и 29: план не продаёт своё же тело без клича', () => {
    for (const turn of [25, 29]) {
      const plan = spendPlan(decisionPoint(turn), { cards });
      const placed = new Set<number>();
      for (const { recommendation: rec } of plan.steps) {
        const victim = rec.sellFirst ?? (rec.action === 'sell' ? rec.minion : null);
        if (victim !== null && placed.has(victim.entityId)) {
          expect(cards.info(victim.cardId)?.mechanics, `ход ${String(turn)}`).toContain('BATTLECRY');
        }
        if ((rec.action === 'buy' || rec.action === 'play') && rec.minion !== null) {
          placed.add(rec.minion.entityId);
        }
      }
    }
    const first25 = spendPlan(decisionPoint(25), { cards }).steps[0]?.recommendation;
    expect(first25?.action).toBe('play');
    expect(first25?.minion?.cardId).toBe('BG33_825');
  });

  /**
   * Двигатель второй половины партии (D224): золотой Kalecgos («After you
   * trigger a Battlecry, give your Dragons +4/+4») и Бранн («Your Battlecries
   * trigger twice») — каждый розыгрыш кличевого давал +8/+8 каждому дракону.
   * Игрок крутил кличевых десятками (ход 27 — одиннадцать розыгрышей,
   * десять продаж), план прежде не предлагал ни одной прокрутки. Ход 29:
   * в руке три Chromadrake, в витрине Oozeling Gladiator — теперь план
   * разыгрывает их и кладёт прибавку на драконов.
   */
  it('ход 29: клич кормит Kalecgos, и план разыгрывает кличевых', () => {
    const state = decisionPoint(29);
    expect(battlecryPayoffOf(state.board, cards)).toMatchObject({
      buffs: [{ race: 'DRAGON', attack: 4, health: 4 }],
      times: 2,
    });

    const plan = spendPlan(state, { cards });
    const fed = plan.steps.filter(
      (s) =>
        (s.recommendation.action === 'play' || s.recommendation.action === 'buy') &&
        (cards.info(s.recommendation.minion?.cardId ?? '')?.mechanics.includes('BATTLECRY') ?? false),
    );
    expect(fed.length).toBeGreaterThanOrEqual(3);

    const kalecAttack = (s: GameState): number =>
      s.board.find((m) => m.cardId === 'TB_BaconUps_109')?.attack ?? 0;
    const last = plan.steps.at(-1)?.stateAfter ?? state;
    expect(kalecAttack(last) - kalecAttack(state)).toBeGreaterThanOrEqual(8 * fed.length);
  });

  /**
   * Major Hymn («Attack equal to your Tier», дважды за ход) игрок с хода 21
   * клал на Warpwing («Immune while attacking»), советник — на крупнейшего,
   * Ignition Specialist. Прибавка только к атаке телу, которое бьёт без
   * ответного урона, против поля лучше: +1.5 п.п. на ходу 21, +0.7 на ходу 25
   * (D225). Minor Hymn (здоровье) правило не трогает.
   */
  it('ходы 21 и 25: атака силы героя — на Warpwing', () => {
    for (const turn of [21, 25]) {
      const plan = spendPlan(decisionPoint(turn), { cards });
      const power = plan.steps.find((s) => s.recommendation.action === 'heroPower')?.recommendation;
      expect(power?.grantsStats?.stat, `ход ${String(turn)}`).toBe('attack');
      expect(power?.targetMinion?.cardId, `ход ${String(turn)}`).toBe('BG24_004');
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
