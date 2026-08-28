import { beforeAll, describe, expect, it } from 'vitest';

import { toBattleInfo } from '../../src/advisors/battle/mapper.js';
import { sharedBattleSimulator, type BattleSimulator } from '../../src/advisors/battle/simulator.js';
import { battleQuestion } from '../../src/advisors/position/advisor.js';
import { withSeededRandom } from '../../src/advisors/position/rng.js';
import { buyRules, heroPowerBuyReward, minionValue } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { part34Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part34 — двадцать шестая партия с оверлеем (28.08.2026, 01:47–02:24,
 * Бранн-укротитель `TB_BaconShop_HERO_43_SKIN_G`, пираты с кличами,
 * **1-е место**), восьмая на билде 250339. Два вопроса игрока.
 *
 * Первый: «не предлагало купить карты с боевыми кличами, хотя герой
 * ускоренно получает Бранна за такие покупки — кто прав?». Сила — «Бранное
 * дело» `TB_BaconShop_HP_048`: «After you buy 4 Battlecry minions, get
 * a Brann Bronzebeard. (Once per game.)», ПАССИВНАЯ (без `HAS_ACTIVATE_POWER`
 * и `COST`), счётчик — `TAG_SCRIPT_DATA_NUM_1` 3 → 2 → 1 → 0 блоком TRIGGER
 * внутри блока покупки. Прав игрок: советник не читал клич как условие
 * силы, и на ходу 1 звал Risen Rider 6.0 вместо Southsea Busker 4.0,
 * на ходу 3 — золотую Aureate Laureate 11.5 вместо Busker 8.5. Игрок
 * купил четыре кличевых за четыре хода таверны (Busker ×3, Shell
 * Collector), получил Бранна на 4-м и выиграл партию.
 *
 * Второй: «советует поставить Бранна вторым — верно ли?». Скриншот —
 * ход 11 (тир 4, золото 0/8, hp 30+16), борд Azsharan Cutlassier 6/4 →
 * Shell Collector 4/3 → Busker 3/1 → Busker 3/1 → Brann 2/4 → Oozeling
 * Gladiator 2/2 → Aureate Laureate 6/6 (зол, провокация, щит); совет —
 * Бранна вторым, Shell Collector пятым, «+1.3 п.п. к 93%» по полю из пяти
 * бордов. Верно, но мало и держится на ОДНОМ борде из пяти: против
 * четырёх остальных всё 100/100, а против пяти тел тиров 1–2 с щитом
 * и хрипом Бранн вторым даёт ~85% против ~80% «как стоит»; Бранн ПЕРВЫМ —
 * единственная явно плохая позиция (~74%): 2 атаки вместо 6 у Cutlassier.
 */
describe('part34: сила «после четырёх кличевых покупок — Бранн» и Бранн вторым в расстановке', () => {
  let cards: CardIndex;
  let simulator: BattleSimulator;
  /** Точки решения ходов 1, 3, 5, 7 — до первой траты золота. */
  const decisions: Partial<Record<number, GameState>> = {};
  /** Ход 7 сразу после четвёртой кличевой покупки: Бранн в руке, счётчик 0. */
  let brann7: GameState | null = null;
  /** Скриншот хода 11: золото 0/8, борд из семи в порядке скриншота. */
  let shot11: GameState | null = null;
  let finalState: GameState;

  const SHOT_ORDER = ['BG33_830', 'BG23_002', 'BG26_135', 'BG26_135', 'BG_LOE_077', 'BG27_002', 'BG32_236'];

  beforeAll(() => {
    const text = part34Game();
    cards = loadCardIndex();
    simulator = sharedBattleSimulator();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;
      if ([1, 3, 5, 7].includes(s.turn) && s.goldSpent === 0 && s.shop.length >= 3 && decisions[s.turn] === undefined) {
        decisions[s.turn] = s;
      }
      if (s.turn === 7 && brann7 === null && s.hand.some((m) => m.cardId === 'BG_LOE_077')) brann7 = s;
      if (
        s.turn === 11 &&
        shot11 === null &&
        s.gold === 0 &&
        s.board.map((m) => m.cardId).join(',') === SHOT_ORDER.join(',')
      ) {
        shot11 = s;
      }
    }
    finalState = reducer.snapshot();
  }, 900_000);

  /** `buyRules` отдаёт советы в порядке витрины; ранжирует их `adviseTavern`. */
  const topBuy = (s: GameState) => [...buyRules(s, { cards })].sort((a, b) => b.score - a.score)[0];

  const decision = (turn: number): GameState => {
    const s = decisions[turn];
    if (s === undefined) throw new Error(`нет точки решения хода ${String(turn)}`);
    return s;
  };

  it('партия дочитывается до конца: 1-е место, Бранн-укротитель, билд 250339', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(1);
    expect(finalState.hero?.cardId).toBe('TB_BaconShop_HERO_43_SKIN_G');
    expect(finalState.buildNumber).toBe(250339);
    // С 02:14:23 событие партии увело «Бранное дело» в SETASIDE и дало чужие
    // силы (класс «Сорванной маски», part30); к концу партии сила — Twice as Nice.
    expect(finalState.hero?.heroPowerCardId).toBe('BG22_HERO_004p');
  });

  /**
   * `TEMP_RESOURCES` — временное золото хода: «Battlecry: Gain 1 Gold next
   * turn» (Busker) кладёт его в начале следующего хода, и тратится оно
   * ПЕРВЫМ (подъём за 3 при `TEMP=1` → `TEMP=0`, `RESOURCES_USED=2`).
   * До part34 редьюсер тега не читал, и ход после Busker был на монету
   * беднее: 4 вместо 5 на ходу 3, 6 вместо 7 на ходу 7. План хода 5
   * с шестью золотыми — «поднять за 3 → купить Busker за 3» — ровно то,
   * что игрок и сделал (01:49:41 подъём, 01:49:42 покупка).
   */
  it('золото хода после Busker читается с TEMP_RESOURCES: 5/4, 6/5, 7/6 — как «11/10» в игре', () => {
    expect([decision(3).gold, decision(3).goldTotal]).toEqual([5, 4]);
    expect([decision(5).gold, decision(5).goldTotal]).toEqual([6, 5]);
    expect([decision(7).gold, decision(7).goldTotal]).toEqual([7, 6]);
    // После покупки Shell Collector за 3 из семи: временный золотой ушёл
    // первым, `RESOURCES_USED=2`, остаток 4, потрачено за ход — три.
    const after = brann7 as GameState;
    expect(after.gold).toBe(4);
    expect(after.goldSpent).toBe(3);
    const plan5 = spendPlan(decision(5), { cards });
    expect(plan5?.steps.map((st) => st.recommendation.action).slice(0, 2)).toEqual(['levelUp', 'buy']);
    expect(plan5?.steps[1]?.recommendation.minion?.cardId).toBe('BG26_135');
  });

  /**
   * Сила пассивная: тегов `HAS_ACTIVATE_POWER` и `COST` нет, блоков PLAY
   * на ней за партию нет (два «нажатия» силы в журнале — это уже другая
   * сила: с 02:14 событие партии заменило «Бранное дело» на чужие силы).
   * Счётчик — `TAG_SCRIPT_DATA_NUM_1`: при создании тега нет, дальше
   * 3 → 2 → 1 → 0 на покупках ходов 1, 3, 5, 7.
   */
  it('сила читается из лога: пассивная, счётчик покупок 4 → 3 → 2 → 1 → 0', () => {
    for (const turn of [1, 3, 5, 7]) {
      const s = decision(turn);
      expect(s.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_048');
      expect(s.hero?.heroPowerHasActivate).toBe(false);
      expect(s.hero?.heroPowerCost).toBeNull();
    }
    expect(decision(1).hero?.heroPowerScriptData[0]).toBeNull();
    expect(decision(3).hero?.heroPowerScriptData[0]).toBe(3);
    expect(decision(5).hero?.heroPowerScriptData[0]).toBe(2);
    expect(decision(7).hero?.heroPowerScriptData[0]).toBe(1);
    expect(brann7).not.toBeNull();
    expect((brann7 as GameState).hero?.heroPowerScriptData[0]).toBe(0);
    expect(cards.info('TB_BaconShop_HP_048')?.text).toMatch(/After you buy 4/);
  });

  /**
   * Что купил игрок: Busker (ход 1), Busker + золотая Laureate (ход 3,
   * Busker тут же продан — цикл ради счётчика), Busker (ход 5), Shell
   * Collector (ход 7). Золотая Laureate клича не несёт, и счётчик её
   * не заметил (в логе — ни блока TRIGGER на силе, ни смены NUM_1).
   */
  it('журнал: четыре кличевых покупки за четыре хода таверны, Бранн приходит на ходу 7', () => {
    const buys = finalState.actions.filter((a) => a.type === 'buy').slice(0, 5);
    expect(buys.map((a) => `${String(a.turn)}:${a.cardId ?? ''}`)).toEqual([
      '1:BG26_135',
      '3:BG26_135',
      '3:BG32_236',
      '5:BG26_135',
      '7:BG23_002',
    ]);
    const battlecries = buys.filter((a) => (cards.info(a.cardId ?? '')?.mechanics ?? []).includes('BATTLECRY'));
    expect(battlecries).toHaveLength(4);
    const sells = finalState.actions.filter((a) => a.type === 'sell').slice(0, 1);
    expect(sells.map((a) => `${String(a.turn)}:${a.cardId ?? ''}`)).toEqual(['3:BG26_135']);
    const s = brann7 as GameState;
    expect(s.hand.map((m) => m.cardId)).toContain('BG_LOE_077');
    expect(cards.info('BG_LOE_077')?.techLevel).toBe(5);
  });

  /**
   * Пункт 1 — ответ числом. Сила читается: четыре покупки, механика
   * BATTLECRY, награда — Brann Bronzebeard из пула, остаток — живой тег.
   * Ценность награды на этом борде делится на оставшиеся покупки, и клич
   * становится причиной покупки там, где раньше стоял ноль.
   */
  it('ход 1: Southsea Busker (клич) встаёт над Risen Rider — прежде было 4.0 против 6.0', () => {
    const s = decision(1);
    expect(s.gold).toBe(3);
    expect(s.board).toHaveLength(0);
    const reward = heroPowerBuyReward(s, cards);
    expect(reward?.reward.id).toBe('BG_LOE_077');
    expect(reward?.mechanic).toBe('BATTLECRY');
    expect(reward?.count).toBe(4);
    expect(reward?.remaining).toBe(4);

    const busker = s.shop.find((m) => m.cardId === 'BG26_135') as Minion;
    const rider = s.shop.find((m) => m.cardId === 'BG25_001') as Minion;
    const b = minionValue(busker, s, { cards });
    const r = minionValue(rider, s, { cards });
    // Бранн на пустом борде: тир 5 → 10, тело 2/4 → 3; четверть — 3.25.
    expect(b.heroPowerBuy).toBeCloseTo(3.25, 5);
    expect(b.heroPowerBuyLeft).toBe(3);
    expect(r.heroPowerBuy).toBe(0);
    expect(b.total).toBeGreaterThan(r.total);

    const top = topBuy(s);
    expect(top?.minion?.cardId).toBe('BG26_135');
    expect(top?.reason).toContain('сила героя: до Brann Bronzebeard ещё 3 такие покупки');
    expect(spendPlan(s, { cards })?.steps[0]?.recommendation.minion?.cardId).toBe('BG26_135');
  });

  it('ход 3: Busker 13.3 над золотой Laureate 11.5; ход 5 — Busker с долей 7.3', () => {
    const s3 = decision(3);
    const busker3 = s3.shop.find((m) => m.cardId === 'BG26_135') as Minion;
    const laureate = s3.shop.find((m) => m.cardId === 'BG32_236') as Minion;
    expect(minionValue(busker3, s3, { cards }).heroPowerBuyLeft).toBe(2);
    expect(minionValue(busker3, s3, { cards }).total).toBeGreaterThan(
      minionValue(laureate, s3, { cards }).total,
    );
    expect(topBuy(s3)?.minion?.cardId).toBe('BG26_135');

    const s5 = decision(5);
    const busker5 = s5.shop.find((m) => m.cardId === 'BG26_135') as Minion;
    const v5 = minionValue(busker5, s5, { cards });
    expect(v5.heroPowerBuyLeft).toBe(1);
    // Половина награды: Бранн при двух своих кличевых стоит 14.5.
    expect(v5.heroPowerBuy).toBeCloseTo(7.25, 5);
    expect(topBuy(s5)?.minion?.cardId).toBe('BG26_135');
    // Первым шагом плана на шести золотых идёт подъём за 3, Busker — вторым.
    expect(spendPlan(s5, { cards })?.steps.some((st) => st.recommendation.minion?.cardId === 'BG26_135')).toBe(true);
  });

  /**
   * Последняя покупка стоит ЦЕЛОГО Бранна — она его и приносит: на ходу 7
   * все три кличевых кандидата витрины несут +16.0 (Бранн при двух
   * кличевых своих), и совет говорит «эта покупка приносит Brann
   * Bronzebeard». После неё счётчик ноль, и слагаемого больше нет.
   */
  it('ход 7: последняя кличевая покупка стоит целого Бранна, после неё — ноль', () => {
    const s = decision(7);
    for (const m of s.shop) {
      const v = minionValue(m, s, { cards });
      expect(v.heroPowerBuy).toBeCloseTo(16, 5);
      expect(v.heroPowerBuyLeft).toBe(0);
    }
    const shell = buyRules(s, { cards }).find((r) => r.minion?.cardId === 'BG23_002');
    expect(shell?.heroPowerBuyLeft).toBe(0);
    expect(shell?.reason).toContain('сила героя: эта покупка приносит Brann Bronzebeard');

    const after = brann7 as GameState;
    expect(heroPowerBuyReward(after, cards)).toBeNull();
    for (const m of after.shop) {
      expect(minionValue(m, after, { cards }).heroPowerBuy).toBe(0);
    }
  });

  /**
   * Пункт 2 — Бранн вторым. Сеяный прогон против того единственного борда
   * поля, на котором исход не 100%: Бранн 2-м лучше «как стоит», Бранн 1-м
   * хуже обоих. Разница по полю из пяти — около 1 п.п., и это не ошибка
   * совета, а его цена: у Бранна нет боевого эффекта, провокация Laureate
   * собирает удары, и позиция Бранна решает только очередь его же атаки.
   */
  it('скриншот хода 11: Бранн 2-м лучше «как стоит», Бранн 1-м — хуже', () => {
    expect(shot11).not.toBeNull();
    const s = shot11 as GameState;
    expect(s.techLevel).toBe(4);
    expect(s.goldTotal).toBe(8);
    expect(s.hero?.armor).toBe(16);
    const brann = s.board.find((m) => m.cardId === 'BG_LOE_077') as Minion;
    expect(brann.attack).toBe(2);
    expect(brann.health).toBe(4);
    expect(s.board[6]?.taunt).toBe(true);
    expect(s.board[6]?.divineShield).toBe(true);

    const question = battleQuestion(s);
    expect(question?.target.kind).toBe('field');
    expect(question?.setups).toHaveLength(5);
    const decisive = question?.setups.find((st) => st.opponentBoard.length === 5);
    expect(decisive).toBeDefined();
    if (decisive === undefined) throw new Error('unreachable');
    expect(decisive.opponentBoard.map((m) => m.cardId)).toContain('BG29_611');

    const rest = s.board.filter((m) => m !== brann);
    const N = 3000;
    const run = (board: readonly Minion[]) =>
      withSeededRandom(20260828, () => simulator.run(toBattleInfo({ ...decisive, playerBoard: board }, N), N));
    const score = (r: { wonPercent: number; tiedPercent: number }) => r.wonPercent + 0.5 * r.tiedPercent;
    const current = score(run(s.board));
    const second = score(run([rest[0] as Minion, brann, rest[2] as Minion, rest[3] as Minion, rest[1] as Minion, rest[4] as Minion, rest[5] as Minion]));
    const first = score(run([brann, ...rest]));
    expect(second).toBeGreaterThan(current);
    expect(current).toBeGreaterThan(first);
    // Порядок величин: ~85 / ~81 / ~74. Разница «совет − как стоит» на этом
    // борде — единицы п.п., по полю из пяти — около одного.
    expect(second - current).toBeGreaterThan(1);
    expect(second - current).toBeLessThan(10);
  }, 120_000);
});
