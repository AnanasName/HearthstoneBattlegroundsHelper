import { describe, expect, it } from 'vitest';

import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part2Game, part3Game } from '../fixtures.js';

/** Снимки состояния по ходу партии — иначе видно только финал. */
function snapshots(): GameState[] {
  const text = part2Game();
  const reducer = createReducer(readPlayers(text));
  const out: GameState[] = [];
  let n = 0;

  for (const event of readPowerEvents(text)) {
    reducer.step(event);
    n += 1;
    if (n % 500 === 0) out.push(reducer.snapshot());
  }
  return out;
}

/**
 * Сверка с data/fixtures/part2/part2.expected.json — теми точками,
 * которые подтвердил человек: герой Воришка Бигглсуорт, 5-е место,
 * аномалия «Ложные идолы», максимальный тир таверны 5.
 */
describe('readPlayers на эталонной партии', () => {
  it('опознаёт своего игрока по ненулевому GameAccountId', () => {
    const players = readPlayers(part2Game());

    expect(players.decls).toHaveLength(2);
    expect(players.decls.filter((d) => d.hasAccount)).toHaveLength(1);
    expect(players.selfPlayerId).toBe(4);
    expect(players.selfName).toBe('AngryMem#2886');
  });

  it('второй слот — системный, без аккаунта', () => {
    const players = readPlayers(part2Game());
    const other = players.decls.find((d) => !d.hasAccount);

    expect(other?.playerId).toBe(12);
    expect(players.names.get(12)).toBe('SilentStorm');
  });
});

describe('reduceLog на эталонной партии', () => {
  const state = reduceLog(part2Game());

  it('партия закончена', () => {
    expect(state.phase).toBe('gameOver');
  });

  it('находит своего героя через HERO_ENTITY, а не по cardId', () => {
    // cardId героя на концовке не уникален: под player=4 проходит служебный
    // двойник id=16441 с тем же cardId. HERO_ENTITY указывает на настоящего.
    expect(state.hero?.entityId).toBe(94);
    expect(state.hero?.cardId).toBe('TB_BaconShop_HERO_70_SKIN_H');
  });

  it('финальное место совпадает с подтверждённым человеком', () => {
    expect(state.finalPlace).toBe(5);
  });

  it('аномалия партии совпадает с подтверждённой человеком', () => {
    expect(state.anomalyCardId).toBe('BG27_Anomaly_301');
  });

  it('тир таверны дорос до 5', () => {
    expect(state.techLevel).toBe(5);
  });

  it('ход дошёл до 24', () => {
    expect(state.turn).toBe(24);
  });

  it('игрок опознан по BattleTag', () => {
    expect(state.playerBattleTag).toBe('AngryMem#2886');
    expect(state.playerId).toBe(4);
  });

  it('борд не больше семи миньонов — жёсткое правило Battlegrounds', () => {
    expect(state.board.length).toBeLessThanOrEqual(7);
  });

  it('у миньонов борда заполнены cardId и позиция', () => {
    for (const m of state.board) {
      expect(m.cardId).not.toBe('');
      expect(m.zonePos).toBeGreaterThanOrEqual(0);
    }
  });

  it('позиции борда идут по возрастанию', () => {
    const positions = state.board.map((m) => m.zonePos);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('SHOW_ENTITY раскрывает карту', () => {
  // Формат отличается от FULL_ENTITY ключом: там ID=, здесь Entity=.
  // Пока разбор искал только первую форму, теги после SHOW_ENTITY терялись,
  // а раскрытые карты оставались без cardId — из 1084 энчантов партии
  // виден был 21.
  const log = [
    'D 00:00:01.0000000 GameState.DebugPrintGame() - PlayerID=4, PlayerName=Me#1',
    'D 00:00:01.0000000 GameState.DebugPrintPower() - CREATE_GAME',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     Player EntityID=11 PlayerID=4 GameAccountId=[hi=1 lo=2]',
    'D 00:00:01.0000000 GameState.DebugPrintPower() - FULL_ENTITY - Creating ID=500 CardID=',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     tag=CARDTYPE value=MINION',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     tag=CONTROLLER value=4',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     tag=ZONE value=PLAY',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     tag=ZONE_POSITION value=1',
    'D 00:00:01.0000000 GameState.DebugPrintPower() - SHOW_ENTITY - Updating Entity=500 CardID=BG31_815',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     tag=ATK value=7',
    'D 00:00:01.0000000 GameState.DebugPrintPower() -     tag=HEALTH value=9',
  ].join('\r\n');

  it('подставляет cardId скрытой ранее карте', () => {
    const state = reduceLog(log);
    expect(state.board).toHaveLength(1);
    expect(state.board[0]?.cardId).toBe('BG31_815');
  });

  it('теги после SHOW_ENTITY доходят до состояния', () => {
    const state = reduceLog(log);
    expect(state.board[0]?.attack).toBe(7);
    expect(state.board[0]?.health).toBe(9);
  });
});

describe('энчанты', () => {
  const state = reduceLog(part2Game());

  it('на эталонной партии энчанты доезжают до миньонов', () => {
    const withEnchantments = state.board.filter((m) => m.enchantments.length > 0);
    expect(withEnchantments.length).toBeGreaterThan(0);
  });

  it('у энчантов есть cardId и они отсортированы по порядку наложения', () => {
    for (const m of state.board) {
      const timings = m.enchantments.map((e) => e.timing);
      expect([...timings].sort((a, b) => a - b)).toEqual(timings);
      for (const e of m.enchantments) {
        expect(e.cardId).not.toBe('');
        expect(e.timing).toBe(e.entityId);
      }
    }
  });

  it('сырые теги и scriptData доезжают', () => {
    for (const m of state.board) {
      expect(m.scriptData).toHaveLength(6);
      expect(Object.keys(m.tags).length).toBeGreaterThan(0);
    }
  });
});

describe('признаки миньонов и сила героя', () => {
  const state = reduceLog(part2Game());

  it('золотые определяются тегом PREMIUM, а не суффиксом _G', () => {
    // В эталонной партии 25 золотых миньонов не имеют суффикса _G,
    // обратных случаев нет ни одного — эвристика по имени пропускала их.
    const golden = state.board.filter((m) => m.golden);
    expect(golden.length).toBeGreaterThan(0);
  });

  it('maxHealth не меньше текущего здоровья', () => {
    for (const m of [...state.board, ...state.hand]) {
      if (m.health === null || m.maxHealth === null) continue;
      expect(m.maxHealth).toBeGreaterThanOrEqual(m.health);
    }
  });

  it('сила героя опознана', () => {
    expect(state.hero?.heroPowerCardId).not.toBeNull();
    expect(state.hero?.heroPowerCardId).toMatch(/^TB_BaconShop_HP_/);
  });

  it('ключевые слова читаются как булевы признаки', () => {
    const all = [...state.board, ...state.shop, ...state.opponentBoard];
    for (const m of all) {
      expect(typeof m.taunt).toBe('boolean');
      expect(typeof m.stealth).toBe('boolean');
      expect(typeof m.divineShield).toBe('boolean');
    }
  });
});

describe('следующий противник известен заранее', () => {
  /**
   * Проверено на обеих полных партиях: объявление NEXT_OPPONENT_PLAYER_ID
   * в таверне точно называет того, с кем предстоит драться. 18 совпадений
   * из 18 сопоставимых; несопоставимы только первые бои партий, где
   * объявления ещё не было.
   *
   * Это и есть ответ на вопрос, против кого считать расстановку в таверне.
   */
  function announcedVersusActual(text: string): { checks: number; matches: number } {
    const reducer = createReducer(readPlayers(text));
    let announced: number | null = null;
    let lastOpponent: number | null = null;
    let checks = 0;
    let matches = 0;

    for (const event of readPowerEvents(text)) {
      reducer.step(event);

      // Снимок берётся только там, где что-то из интересующего могло
      // измениться. Сборка состояния перебирает все сущности партии, и звать
      // её на каждом из 110 тысяч событий — нагрузка, которой в живом режиме
      // не бывает: там снимок нужен раз в секунду.
      const c = event.line.content;
      if (!c.includes('HERO_ENTITY') && !c.includes('NEXT_OPPONENT_PLAYER_ID')) continue;

      const s = reducer.snapshot();

      // Сверять надо не в секунду входа в бой: противник подставляется чуть
      // позже, и до этого в поле висит соперник прошлого боя. Ловим сам
      // момент смены.
      if (s.currentOpponentPlayerId !== null && s.currentOpponentPlayerId !== lastOpponent) {
        if (announced !== null) {
          checks += 1;
          if (s.currentOpponentPlayerId === announced) matches += 1;
        }
        lastOpponent = s.currentOpponentPlayerId;
      }

      if (s.phase === 'tavern' && s.nextOpponentPlayerId !== null) {
        announced = s.nextOpponentPlayerId;
      }
    }
    return { checks, matches };
  }

  it('part2: объявленный противник совпадает с фактическим', () => {
    const { checks, matches } = announcedVersusActual(part2Game());
    expect(checks).toBeGreaterThan(8);
    expect(matches).toBe(checks);
  });

  it('part3: то же самое', () => {
    const { checks, matches } = announcedVersusActual(part3Game());
    expect(checks).toBeGreaterThan(5);
    expect(matches).toBe(checks);
  });

  it('борды противников накапливаются по итогам боёв', () => {
    const state = reduceLog(part2Game());
    const seen = Object.entries(state.lastSeenBoards);

    // За партию мы дрались с семью разными игроками лобби.
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const [, board] of seen) {
      expect(board.length).toBeGreaterThan(0);
      expect(board.length).toBeLessThanOrEqual(7);
    }
  });

  it('счётчики globalInfo заполняются осмысленными значениями', () => {
    const state = reduceLog(part2Game());
    expect(state.globalInfo.goldSpentThisGame).toBeGreaterThan(100);
    expect(state.globalInfo.spellsCastThisGame).toBeGreaterThan(0);
  });
});

describe('магазин и борд противника по ходу партии', () => {
  const shots = snapshots();

  it('снимков достаточно, и обе фазы встречаются', () => {
    expect(shots.length).toBeGreaterThan(50);
    expect(shots.some((s) => s.phase === 'tavern')).toBe(true);
    expect(shots.some((s) => s.phase === 'combat')).toBe(true);
  });

  it('свой борд нигде за партию не превышает семи миньонов', () => {
    const worst = Math.max(...shots.map((s) => s.board.length));
    expect(worst).toBeLessThanOrEqual(7);
  });

  it('магазин заполняется в таверне и пуст вне её', () => {
    const inTavern = shots.filter((s) => s.phase === 'tavern');
    expect(inTavern.some((s) => s.shop.length > 0)).toBe(true);

    for (const s of shots) {
      if (s.phase !== 'tavern') expect(s.shop).toHaveLength(0);
    }
  });

  it('размер магазина правдоподобен: не больше семи позиций', () => {
    const worst = Math.max(...shots.map((s) => s.shop.length));
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(7);
  });

  it('борд противника виден в бою и пуст вне боя', () => {
    const inCombat = shots.filter((s) => s.phase === 'combat');
    expect(inCombat.some((s) => s.opponentBoard.length > 0)).toBe(true);

    for (const s of shots) {
      if (s.phase !== 'combat') expect(s.opponentBoard).toHaveLength(0);
    }
  });

  it('борд противника тоже не длиннее семи', () => {
    const worst = Math.max(...shots.map((s) => s.opponentBoard.length));
    expect(worst).toBeLessThanOrEqual(7);
  });

  it('магазин и борд противника никогда не заполнены одновременно', () => {
    for (const s of shots) {
      expect(s.shop.length > 0 && s.opponentBoard.length > 0).toBe(false);
    }
  });

  it('золото за партию не выходит за разумные пределы', () => {
    for (const s of shots) {
      expect(s.gold).toBeGreaterThanOrEqual(0);
      expect(s.gold).toBeLessThanOrEqual(20);
    }
  });

  it('тир таверны растёт монотонно и доходит до 5', () => {
    const levels = shots.map((s) => s.techLevel);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i]!).toBeGreaterThanOrEqual(levels[i - 1]!);
    }
    expect(Math.max(...levels)).toBe(5);
  });
});
