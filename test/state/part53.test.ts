import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, minionValue } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part53Game } from '../fixtures.js';

/**
 * part53 — Провидец Нобундо (16.09.2026), 4-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Здесь держится главное, что она
 * принесла: ЦЕНА СИЛЫ ГЕРОЯ, ДОХОДЯЩАЯ ДО НУЛЯ, и карта, которую сила
 * выдаст, названная тегом на её собственной сущности.
 */
describe('part53: сила героя, дешевеющая до нуля', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  // Лог 62 МБ: без пауз разбор держит поток воркера дольше тайм-аута RPC.
  beforeAll(async () => {
    text = part53Game();
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

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(4);
    expect(turns).toHaveLength(13);
    expect(final.hero?.heroPowerCardId).toBe('BG31_HERO_003p');
  });

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  /** Состояние на момент времени — срезом лога (метод part40, part43–part52). */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  /**
   * Нажатия силы — блоки `PLAY` на её сущности В КАНАЛЕ-ИСТОЧНИКЕ
   * (`GameState.DebugPrintPower`): `PowerTaskList` дублирует каждое, и по
   * обоим каналам нажатий выходило бы вдвое больше.
   */
  const presses = (): number[] =>
    lines
      .map((line, i) => ({ line, i }))
      .filter(
        ({ line }) =>
          line.includes('GameState.DebugPrintPower()') &&
          line.includes('BLOCK_START BlockType=PLAY') &&
          line.includes('cardId=BG31_HERO_003p'),
      )
      .map(({ i }) => i);

  /**
   * Цена силы на ТОЧКАХ РЕШЕНИЯ идёт 3 → 2 → 1 и ни разу не показывает ноль:
   *
   *   ходы 1,3,5    3, 2, 1      ходы 15,17    2, 1
   *   ходы 7,9,11   3, 2, 1      ходы 19,21    2, 1
   *   ходы 13       3            ходы 23,25    2, 2
   *
   * Это НЕ значит, что нуля в партии нет. Точка решения — последнее
   * состояние ДО первой траты золота (D119), а «трата» считается ростом
   * счётчика (D180): нажатие БЕСПЛАТНОЙ силы золота не двигает, и точка
   * съезжает за него. Ноль виден только срезом по времени — тестом ниже.
   */
  it('на точках решения цена силы идёт 3 → 2 → 1 и нуля не показывает', () => {
    const costs = turns.map((t) => t.state.hero?.heroPowerCost ?? null);
    expect(costs).toEqual([3, 2, 1, 3, 2, 1, 3, 2, 1, 2, 1, 2, 2]);
    expect(costs).not.toContain(0);
  });

  /**
   * Ход 7, 01:10:00 — цена силы НОЛЬ, и это живой тег, а не «цены нет»:
   *
   *   D 01:09:58.36… TAG_CHANGE Entity=[… id=211 … cardId=BG31_HERO_003p …]
   *     tag=COST value=0
   *   D 01:10:28.94… BLOCK_START BlockType=PLAY Entity=[entityName=
   *     Галактическая линза id=211 … cardId=BG31_HERO_003p player=8]
   *
   * Прежде оба правила силы отсекали такой ноль на входе (`cost <= 0`),
   * и на бесплатной силе советник молчал — ровно там, где нажать её
   * выгоднее всего. Жалоба игрока по кадру была об этом.
   */
  it('ход 7: сила за НОЛЬ советуется и входит в план', () => {
    const frame = at('01:10:00');
    expect(frame.turn).toBe(7);
    expect(frame.hero?.heroPowerCost).toBe(0);
    expect(frame.hero?.heroPowerHasActivate).toBe(true);
    expect(frame.gold).toBe(6);

    const power = adviseTavern(frame, { cards })?.recommendations.find(
      (r) => r.action === 'heroPower',
    );
    expect(power).toBeDefined();
    expect(power?.cost).toBe(0);
    // Слово «бесплатна» — не украшение: при пустом кошельке только оно
    // объясняет, почему шаг всё равно стоит делать.
    expect(power?.reason).toContain('бесплатна');
    expect(power?.reason).toContain('дешевле уже не станет');

    expect(spendPlan(frame, { cards }).steps.some((s) => s.recommendation.action === 'heroPower')).toBe(
      true,
    );
  });

  /**
   * Второй ноль партии — 01:14:36, нажат в 01:15:05. Два нуля за партию,
   * и оба игрок нажал: это и есть выборка, на которой снят пол цены
   * (advisor.ts, `heroPowerCostAfter`).
   */
  it('нулей за партию два, и оба — живой тег COST на сущности силы', () => {
    const zeros = lines.filter(
      (line) =>
        line.includes('GameState.DebugPrintPower()') &&
        line.includes('cardId=BG31_HERO_003p') &&
        line.includes('tag=COST value=0'),
    );
    expect(zeros).toHaveLength(2);
    expect(zeros[0]).toContain('01:09:58');
    expect(zeros[1]).toContain('01:14:36');
  });

  /**
   * Ход 17 (9-й ход таверны, 01:18:32): Titus Rivendare `BG25_354` («Your
   * Deathrattles trigger an extra time») в витрине при ШЕСТИ своих миньонах,
   * из которых с хрипом НОЛЬ. План говорил «КУПИТЬ Titus Rivendare 1/7 за 3»
   * вторым шагом с баллом 14.0, и жалоба игрока была об этом. Раскладка:
   * тир 10 + статы 4 + механика 0 — то есть синергия отработала ВЕРНО и дала
   * ноль, а балл собрала надбавка за тир, платившая за текст, который
   * на этом борде стоит ровно ничего. Игрок Титуса не купил и в 01:20:30
   * смёл витрину бесплатным обновлением.
   *
   * Бранн держится тем же тестом НАМЕРЕННО: он ровно та карта, которую
   * правка не смеет задеть, и его 13.0 на борде без единого клича —
   * это и есть граница правила.
   */
  it('ход 17: аура без носителей теряет надбавку за тир, а Бранн — нет', () => {
    const state = decisionPoint(17);
    const titus = state.shop.find((m) => m.cardId === 'BG25_354');
    expect(titus).toBeDefined();
    expect(state.board.filter((m) => cards.info(m.cardId)?.mechanics.includes('DEATHRATTLE'))).toHaveLength(
      0,
    );

    const value = minionValue(titus!, state, { cards });
    expect(value.textMechMates).toBe(0);
    expect(value.techLevel).toBe(0);
    expect(value.total).toBe(4);

    expect(
      spendPlan(state, { cards }).steps.some((s) => s.recommendation.minion?.cardId === 'BG25_354'),
    ).toBe(false);

    // Бранн — механика РОЗЫГРЫША: пустой борд ему не приговор, надбавку
    // за тир он сохраняет целиком (ход 15, витрина 01:16:30).
    const earlier = decisionPoint(15);
    const brann = earlier.shop.find((m) => m.cardId === 'BG_LOE_077');
    expect(brann).toBeDefined();
    const brannValue = minionValue(brann!, earlier, { cards });
    expect(brannValue.textMechMates).toBe(0);
    expect(brannValue.techLevel).toBe(10);
  });

  /**
   * Balinda Stonehearth `BG35_883` («Your spells that target friendly minions
   * cast twice») на своём борде — и Forest's Bounty в руке. Лог повторяет
   * направленную ветвь целиком: один блок PLAY и два блока POWER, цель
   * получает 2 × 2 × 9/9 = 72 стата (01:21:37 и ещё четыре розыгрыша,
   * все с `SubOption=0`). Советник сравнивал ветви без повтора — 36 против
   * 60 у «всем» — и звал «всем»; игрок пять раз из пяти брал цель.
   *
   * 01:21:08 — Balinda ещё в РУКЕ: повтора нет, и прежний выбор верен.
   */
  it('Balinda на борде переворачивает ветвь Forest\'s Bounty в цель (D219)', () => {
    const branchOf = (frame: GameState): string | undefined =>
      adviseTavern(frame, { cards })
        ?.recommendations.find((r) => r.spellCardId === 'BG31_886')
        ?.spellBranches?.map((b) => b.name)
        .join('/');

    const onBoard = at('01:23:13');
    expect(onBoard.board.map((m) => m.cardId)).toContain('BG35_883');
    expect(branchOf(onBoard)).toBe('All For One');

    const inHand = at('01:21:08');
    expect(inHand.board.map((m) => m.cardId)).not.toContain('BG35_883');
    expect(branchOf(inHand)).toBe('One For All');
  });

  /**
   * **Карта, которую выдаст сила, НАПИСАНА на её сущности.** Тег
   * `BACON_EVOLUTION_CARD_ID` несёт dbfId заклинания, и совпадение
   * с фактически выданной картой — шесть нажатий из шести:
   *
   *   01:07:55 value=104436 → 01:10:28 CardID=BG28_810  (Tavern Coin)
   *   01:13:47 value=105664 → 01:15:05 CardID=BG28_518  (Chef's Choice)
   *   01:20:37 value=104436 → 01:20:58 CardID=BG28_810  (Tavern Coin)
   *   01:25:09 value=104029 → 01:25:10 CardID=BG28_805  (Strike Oil)
   *
   * До part53 тег не читал никто. Тест держит САМО СОВПАДЕНИЕ, а не список
   * карт: он и есть основание читать тег как обещание силы.
   */
  it('BACON_EVOLUTION_CARD_ID на силе называет выданную карту — 6 из 6', () => {
    const offerAt = (before: number): number | null => {
      for (let i = before; i >= 0; i -= 1) {
        const line = lines[i] ?? '';
        if (
          line.includes('GameState.DebugPrintPower()') &&
          line.includes('id=211') &&
          line.includes('tag=BACON_EVOLUTION_CARD_ID')
        ) {
          const value = /tag=BACON_EVOLUTION_CARD_ID value=(\d+)/.exec(line)?.[1];
          return value === undefined ? null : Number(value);
        }
      }
      return null;
    };
    const grantedAt = (press: number): string | null => {
      for (let i = press; i < Math.min(press + 40, lines.length); i += 1) {
        const id = /FULL_ENTITY - Creating ID=\d+ CardID=([A-Za-z0-9_]+)/.exec(lines[i] ?? '')?.[1];
        if (id !== undefined) return id;
      }
      return null;
    };

    const pressed = presses();
    expect(pressed).toHaveLength(6);

    const pairs = pressed.map((i) => {
      const dbf = offerAt(i);
      return {
        promised: dbf === null ? null : (cards.infoByDbfId(dbf)?.id ?? null),
        granted: grantedAt(i),
      };
    });
    expect(pairs.every((p) => p.granted !== null && p.promised === p.granted)).toBe(true);
    expect(pairs.map((p) => p.granted)).toEqual([
      'BG28_810',
      'BG28_518',
      'BG28_810',
      'BG28_805',
      'BG28_805',
      'BG28_805',
    ]);
  });
});
