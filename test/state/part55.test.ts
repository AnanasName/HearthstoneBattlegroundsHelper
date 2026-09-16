import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part55Game } from '../fixtures.js';

/**
 * part55 — Капитан Юдора (16.09.2026), 3-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадров игрок прислал два, оба
 * в чат (verifiedBy: скриншот из чата): 17:01 — ход 3, где оверлей не звал
 * нажать силу героя, и 17:19 — ход 23 с советом купить En-Djinn Blazer.
 */
describe('part55: Юдора, раскопки золотых и пираты', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  // Лог 69 МБ: без пауз разбор держит поток воркера дольше тайм-аута RPC.
  beforeAll(async () => {
    text = part55Game();
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

  /** Состояние на момент времени — срезом лога (метод part40, part43–part54). */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  const label = (list: readonly { cardId: string; attack: number | null; health: number | null }[]): string[] =>
    list.map((m) => `${cards.info(m.cardId)?.name ?? m.cardId} ${String(m.attack)}/${String(m.health)}`);

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(3);
    expect(turns).toHaveLength(15);
    expect(final.hero?.cardId).toBe('TB_BaconShop_HERO_64');
    expect(final.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_074');
  });

  /**
   * Кадр 17:01 (скриншот из чата): ход 3, тир 1, золото 4/4, 30 здоровья
   * и 14 брони, на борде золотая Aureate Laureate, в витрине 3/3, 3/3, 2/1
   * и Enchanted Lasso за 2. Первая трата хода — сила в 17:01:24, так что
   * кадр совпадает с точкой решения.
   */
  it('кадр хода 3 совпадает со скриншотом', () => {
    const frame = at('17:01:10');
    expect(frame.turn).toBe(3);
    expect(frame.techLevel).toBe(1);
    expect(frame.gold).toBe(4);
    expect(frame.tavernUpgradeCost).toBe(4);
    expect(frame.hero?.health).toBe(30);
    expect(frame.hero?.armor).toBe(14);
    expect(label(frame.board)).toEqual(['Aureate Laureate 2/2']);
    expect(frame.board[0]?.golden).toBe(true);
    expect(label(frame.shop)).toEqual(['Molten Rock 3/3', 'Flighty Scout 3/3', 'Ominous Seer 2/1']);
    expect(frame.shopSpells.map((s) => [cards.info(s.cardId)?.name, s.cost])).toEqual([
      ['Enchanted Lasso', 2],
    ]);
    expect(frame.hero?.heroPowerCost).toBe(1);
    expect(frame.hero?.heroPowerScriptData[0]).toBe(4);
  });

  /**
   * Счётчик раскопок — `TAG_SCRIPT_DATA_NUM_1` на силе (id 198):
   *
   *   D 17:00:20.52… FULL_ENTITY - Creating ID=198 CardID=TB_BaconShop_HP_074
   *   D 17:00:20.52…     tag=TAG_SCRIPT_DATA_NUM_1 value=4
   *   D 17:01:24.75… … id=198 … tag=TAG_SCRIPT_DATA_NUM_1 value=3
   *   D 17:04:31.91… … id=198 … tag=TAG_SCRIPT_DATA_NUM_1 value=0
   *   D 17:04:31.91… FULL_ENTITY - Creating ID=2524 CardID=BG23_002_G (ZONE=HAND, CREATOR=198)
   *   D 17:04:31.91… … id=198 … tag=TAG_SCRIPT_DATA_NUM_1 value=4
   *
   * Игрок нажимал силу каждый ход таверны со второго; на точках решения
   * счётчик идёт по кругу 4 → 1, и награды приходят на ходах 9, 17 и 25.
   */
  it('счётчик раскопок на точках решения и три золотые награды', () => {
    expect(turns.map((t) => t.state.hero?.heroPowerScriptData[0])).toEqual([
      4, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3,
    ]);

    // Золотой миньон в руке, созданный силой: тир случайный, не выше своего.
    const rewards: string[] = [];
    let pending: { cardId: string; hand: boolean; bySelf: boolean } | null = null;
    const flush = (): void => {
      if (pending?.hand === true && pending.bySelf) rewards.push(pending.cardId);
      pending = null;
    };
    for (const line of lines) {
      if (!line.includes('GameState.DebugPrintPower()')) continue;
      const created = /FULL_ENTITY - Creating ID=\d+ CardID=(\S*)/.exec(line);
      if (created !== null) {
        flush();
        pending = { cardId: created[1] ?? '', hand: false, bySelf: false };
        continue;
      }
      if (pending === null) continue;
      if (/ tag=ZONE value=HAND\s*$/.test(line)) pending.hand = true;
      else if (/ tag=CREATOR value=198\s*$/.test(line)) pending.bySelf = true;
      else if (!/^\S+ \S+ \S+ -\s+tag=/.test(line)) flush();
    }
    flush();
    expect(rewards).toEqual(['BG23_002_G', 'BG32_820_G', 'BG33_822_G']);
  });

  /**
   * Жалоба игрока №1: «на 1 скриншоте мне не предложило нажать силу героя,
   * которую желательно нажимать на этом герое почаще». До правки советник
   * молчал о силе на всех 15 точках решения.
   *
   * На ходу 3 сила теперь в списке, но план по-прежнему поднимает таверну:
   * подъём за 4 тратит всё золото, и развилка (D044) не открывается.
   */
  it('раскопка советуется: доля по остатку, последняя — целая награда', () => {
    const dig = (turn: number) =>
      adviseTavern(decisionPoint(turn), { cards })?.recommendations.find((r) => r.action === 'heroPower');

    const turn3 = dig(3);
    expect(turn3?.reason).toContain('раскопка 1 из 4');
    expect(turn3?.score).toBeGreaterThan(0);
    // Последняя раскопка — верхний совет хода 9.
    const top9 = adviseTavern(decisionPoint(9), { cards })?.recommendations[0];
    expect(top9?.action).toBe('heroPower');
    expect(top9?.reason).toContain('приходит этим нажатием');
    // Первый круг: доля растёт к последней раскопке.
    const round = [3, 5, 7, 9].map((t) => dig(t)?.score ?? NaN);
    expect(round).toEqual([...round].sort((a, b) => a - b));

    // Ходы таверны 14 и 15: до награды партия не доживёт — сила молчит.
    expect(dig(27)).toBeUndefined();
    expect(dig(29)).toBeUndefined();
  });

  /**
   * Кадр 17:19 (скриншот из чата): ход 23, тир 6, золото 8/10, 11 здоровья,
   * шесть пиратов борда со статами в сотнях, в витрине En-Djinn Blazer 5/5,
   * Auto Assembler 2/2 и Captain Cookie 5/3. Между 17:19:38 (продан Patient
   * Scout) и 17:19:44 (разыгран Flighty Scout) игрок ничего не делал.
   */
  it('кадр хода 23 совпадает со скриншотом', () => {
    const frame = at('17:19:40');
    expect(frame.turn).toBe(23);
    expect(frame.techLevel).toBe(6);
    expect(frame.gold).toBe(8);
    expect(frame.goldTotal).toBe(10);
    expect((frame.hero?.health ?? 0) - (frame.hero?.damage ?? 0) + (frame.hero?.armor ?? 0)).toBe(11);
    expect(label(frame.board)).toEqual([
      'Blade Collector 130/209',
      'Maritime Extortionist 270/258',
      'Sky Admiral Rogers 118/102',
      'Hooktusk, Master Marauder 52/42',
      'Enterprising Escapee 118/108',
      'Brann Bronzebeard 22/4',
    ]);
    expect(frame.board.map((m) => m.golden)).toEqual([false, true, true, false, true, false]);
    expect(label(frame.shop)).toEqual(['En-Djinn Blazer 5/5', 'Auto Assembler 2/2', 'Captain Cookie 5/3']);
    expect(label(frame.hand)).toEqual(['Blade Collector 3/2', 'Flighty Scout 3/3']);
    expect(frame.handSpells.map((s) => cards.info(s.cardId)?.name).sort()).toEqual([
      'Lockbox',
      'Selfish Bounty',
      'Wealthy Bounty',
    ]);
  });

  /**
   * Жалоба игрока №2: «предлагает купить элементаля, который не выглядит
   * полезным». План кадра был «КУПИТЬ En-Djinn Blazer → КУПИТЬ Captain Cookie,
   * продав En-Djinn Blazer → Selfish Bounty → ОБНОВИТЬ». Клич En-Djinn
   * («After the Tavern is Refreshed this game, give a random minion in it
   * +{0}/+{1}») советник не оценивает, все его 14.5 — тело, выброшенное
   * тем же ходом.
   *
   * Причин было две. Отменённый шаг кличевой карты считался оплаченным
   * по дороге (исправлено в D224). И остаток после обновления, которым план
   * обрывается, считался сгоревшим (D227): цепочка «Cookie → Selfish →
   * обновить» оставляла 4 золота и стоила 26 − 12 = 14, а цепочка
   * с En-Djinn оставляла 2 и стоила 41.5 − 20.5 − 6 = 15.
   */
  it('ход 23: план не покупает En-Djinn Blazer, чтобы продать его тем же ходом', () => {
    for (const [label23, state] of [
      ['кадр 17:19:40', at('17:19:40')],
      ['точка решения', decisionPoint(23)],
    ] as const) {
      const plan = spendPlan(state, { cards });
      const bought = plan.steps.filter(
        (s) => s.recommendation.action === 'buy' && s.recommendation.minion?.cardId === 'BG34_865',
      );
      expect(bought, label23).toEqual([]);
    }
    const frameFirst = spendPlan(at('17:19:40'), { cards }).steps[0]?.recommendation;
    expect(frameFirst?.minion?.cardId).toBe('BG36_760');
  });

  /**
   * Hooktusk, Master Marauder на своём борде (D232): «After you Discover
   * a card, give your other Pirates +{0}/+{1}». Игрок крутил источники
   * Discover, и каждый кормил пиратов:
   *
   *   D 17:15:04.60… BLOCK_START BlockType=TRIGGER Entity=[… id=9122 … cardId=BG36_344 …]
   *   D 17:15:04.60…     SUB_SPELL_START … Source=9122 TargetCount=5
   *
   * (Discover от Rodeo Performer, выбран Overconfidence), и так же после
   * Hired Headhunter (17:15:58). До правки Rodeo стоил 13.5 телом, ниже
   * Costume Enthusiast 19.0, а Headhunter — 12.9, ниже Shell Collector 17.5.
   */
  it('кадры хода 19: Discover при Hooktusk ведёт план, как у игрока', () => {
    const rodeoFrame = spendPlan(at('17:14:58'), { cards }).steps[0]?.recommendation;
    expect(['buy', 'spin']).toContain(rodeoFrame?.action);
    expect(rodeoFrame?.minion?.cardId).toBe('BG28_550');

    const headhunter = adviseTavern(at('17:15:54'), { cards })?.recommendations[0];
    expect(headhunter?.action).toBe('buy');
    expect(headhunter?.spellCardId).toBe('BG28_GIL_836');
    expect(headhunter?.reason).toContain('Discover кормит своих');
  });

  /**
   * Ход 7 (D229): тир 2 взят на третьем ходу таверны, и подъём на 3 стоит
   * все 6 золотых. Игрок нажал силу и купил два Shell Collector; против поля
   * его борд на ходу таверны 4 — 46.1 % против 10.2 % у подъёма. Развилка
   * теперь сравнивает подъём и с цепочкой покупок.
   *
   *   D 17:02:44.97… TB_BaconShopTechUp03_Button … tag=COST value=6
   *
   * Ход 9 — подъём остаётся: за 5 из 7, и монетка открывает Search Through
   * Time на оставшийся после силы золотой (D233).
   */
  it('ход 7: подъём за всё золото после запоздалого тира уступает покупкам, ход 9 — нет', () => {
    const turn7 = decisionPoint(7);
    expect(turn7.techLevel).toBe(2);
    expect(turn7.tavernUpgradeCost).toBe(6);
    expect(turn7.techLevelUpTurn).toBe(5);
    const plan7 = spendPlan(turn7, { cards }).steps.map((s) => s.recommendation.action);
    expect(plan7).not.toContain('levelUp');
    expect(plan7).toContain('heroPower');

    const plan9 = spendPlan(decisionPoint(9), { cards }).steps.map((s) => s.recommendation);
    expect(plan9.map((r) => r.action)).toEqual(['heroPower', 'levelUp', 'play', 'buy']);
    expect(plan9[3]?.spellCardId).toBe('BG34_330');
  });

  it('план берёт силу, когда золото иначе остаётся: ходы 5 и 9', () => {
    for (const turn of [5, 9]) {
      const plan = spendPlan(decisionPoint(turn), { cards });
      expect(plan.steps.map((s) => s.recommendation.action), `ход ${String(turn)}`).toContain('heroPower');
      expect(plan.goldLeft, `ход ${String(turn)}`).toBe(0);
    }
  });

  /**
   * Ход 11: точка решения стоит ДО выбора тринкета — золота 8, а на экране
   * четыре варианта с ценами 3, 4, 0 и 2. Игрок взял Sunken Anchor за 4
   * (17:05:35, `m_chosenEntities[0]` → `BG35_MagicItem_890`), а план
   * строился на все восемь: «дар за 3 → Repair Job за 2 → сила за 1 → …».
   * Тратить можно только то, что останется после выбора; план берёт цену
   * ВЕРХНЕГО варианта своего же совета — Archaic Scroll за 3.
   */
  it('ход 11: план и список советов строятся на золоте после верхнего тринкета', () => {
    const state = decisionPoint(11);
    expect(state.gold).toBe(8);
    expect(state.trinketOffer.map((t) => t.cost)).toEqual(expect.arrayContaining([3, 4, 2]));

    const advice = adviseTavern(state, { cards });
    expect(advice?.trinkets[0]?.offer.cardId).toBe('BG32_MagicItem_930');
    expect(advice?.gold).toBe(5);
    // Тёмный дар за 3 и прочие траты судятся на пяти золотых, а сам список
    // тринкетов — на исходном предложении: вычитать нечего дважды.
    expect(advice?.trinkets).toHaveLength(4);

    const plan = spendPlan(state, { cards });
    expect(plan.steps[0]?.goldBefore).toBe(5);
  });

  it('ход 11: тринкет не по карману в расчёт не идёт — берётся верхний из доступных', () => {
    const state = decisionPoint(11);
    // Два золота: Archaic Scroll (3) и Sunken Anchor (4) не взять,
    // верхний по карману — вариант за 2 или бесплатный.
    const poor = { ...state, gold: 2 };
    const advice = adviseTavern(poor, { cards });
    const affordable = advice?.trinkets.find((t) => (t.offer.cost ?? 0) <= 2);
    expect(advice?.gold).toBe(2 - (affordable?.offer.cost ?? 0));
  });
});
