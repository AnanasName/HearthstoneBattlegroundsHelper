import { beforeAll, describe, expect, it } from 'vitest';

import type { PositionAdvice } from '../../src/advisors/position/advisor.js';
import type { ResolvedOpponent } from '../../src/advisors/position/opponent.js';
import type {
  Recommendation,
  TavernAdvice,
  ValueBreakdown,
} from '../../src/advisors/tavern/advisor.js';
import { buildView, type ViewInput } from '../../src/overlay/view.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { EMPTY_STATE, type GameState } from '../../src/state/types.js';
import { board, minion } from '../minions.js';

/**
 * Что оверлей показывает.
 *
 * Окно поверх игры тестом не проверить, поэтому всё, что можно решить заранее,
 * решено в `view.ts` — и проверяется здесь. На долю Electron остаётся создание
 * окна и передача этой структуры в разметку.
 */

const HERO: GameState['hero'] = {
  entityId: 64,
  cardId: 'BG20_HERO_282',
  health: 30,
  damage: 4,
  armor: 2,
  heroPowerCardId: null,
  heroPowerEntityId: null,
  heroPowerCost: null,
  heroPowerUsedThisTurn: false,
  heroPowerUnplayable: false,
};

const state: GameState = {
  ...EMPTY_STATE,
  phase: 'tavern',
  turn: 9,
  techLevel: 3,
  gold: 7,
  goldTotal: 7,
  hero: HERO,
  board: board([101, 102]),
  shop: board([201, 202]),
};

const tavern: TavernAdvice = {
  gold: 7,
  targetTier: 4,
  shopValues: [],
  trinkets: [],
  choice: [],
  playPlan: [],
  recommendations: [
    {
      action: 'buy',
      minion: minion(201),
      score: 12,
      cost: 3,
      requiresSlot: true,
      sellFirst: minion(102),
      reason: 'своих по племени 2',
    },
    {
      action: 'levelUp',
      minion: null,
      score: 8,
      cost: 5,
      requiresSlot: false,
      sellFirst: null,
      reason: 'по графику пора',
    },
    {
      action: 'reroll',
      minion: null,
      score: 1,
      cost: 1,
      requiresSlot: false,
      sellFirst: null,
      reason: 'ничего не нравится',
    },
  ],
};

function opponent(patch: Partial<ResolvedOpponent> = {}): ResolvedOpponent {
  return {
    source: 'lastSeen',
    playerId: 5,
    board: board([301]),
    seenOnTurn: 7,
    staleTurns: 2,
    usable: true,
    ...patch,
  };
}

function advice(patch: Partial<PositionAdvice> = {}): PositionAdvice {
  return {
    top: [{ key: 'a', board: board([102, 101]), estimate: estimate(), score: 0.6 }],
    current: { key: 'b', board: board([101, 102]), estimate: estimate(), score: 0.5 },
    improves: true,
    gain: 6.2,
    winGain: 5.1,
    elapsedMs: 3200,
    report: {
      top: [],
      current: { key: 'b', board: board([101, 102]), estimate: estimate(), score: 0.5 },
      evaluated: 120,
      simulations: 40_000,
      elapsedMs: 3200,
      space: { size: 2, total: 2, distinct: 2 },
    },
    ...patch,
  } as PositionAdvice;
}

function estimate(): PositionAdvice['current']['estimate'] {
  return {
    sims: 1000,
    won: 540,
    tied: 60,
    lost: 400,
    wonLethal: 0,
    lostLethal: 0,
    damageWon: 0,
    damageLost: 0,
  };
}

const input = (patch: Partial<ViewInput> = {}): ViewInput => ({
  state,
  tavern,
  thinking: false,
  position: null,
  ...patch,
});

describe('вид оверлея', () => {
  let cards: CardIndex;

  beforeAll(() => {
    cards = loadCardIndex();
  }, 60_000);

  it('до выбора героя показывать нечего', () => {
    const view = buildView(input({ state: { ...state, hero: null } }), cards);
    expect(view.active).toBe(false);
  });

  it('шапка, борд, витрина и три первых совета', () => {
    const view = buildView(input(), cards);

    expect(view.header).toContain('ход 9');
    expect(view.header).toContain('золото 7/7');
    // Здоровье с бронёй: 30 − 4 урона, плюс 2 брони.
    expect(view.header).toContain('hp 26+2');
    expect(view.board).toHaveLength(2);
    expect(view.shop).toHaveLength(2);

    // Три совета, не больше: с «разыграть» и подъёмом-приоритетом в топе
    // обычно сочетание разных действий, а простыня оверлею всё же не к лицу.
    expect(view.actions).toHaveLength(3);
    expect(view.actions[0]?.tone).toBe('good');
  });

  it('покупка на полном борде называет, кого продать', () => {
    const view = buildView(input(), cards);
    expect(view.actions[0]?.text).toContain('продав');
  });

  it('открытый выбор карт вытесняет советы, лучший помечен', () => {
    const breakdown = (total: number): ValueBreakdown => ({
      techLevel: 0,
      stats: 0,
      tribe: 0,
      keywords: 0,
      copies: 0,
      golden: 0,
      economy: 0,
      textTribe: 0,
      total,
      tribeMates: 0,
      textTribeMates: 0,
      copiesOwned: 0,
    });
    const withChoice: TavernAdvice = {
      ...tavern,
      choice: [
        {
          option: { entityId: 1, cardId: 'A' },
          name: 'Часовой',
          value: breakdown(18),
          reason: 'тир 4, ценность 18.0',
        },
        {
          option: { entityId: 2, cardId: 'B' },
          name: 'Дар',
          value: null,
          reason: 'не миньон — оценить не берёмся',
        },
      ],
    };
    const view = buildView(input({ tavern: withChoice }), cards);

    expect(view.actions[0]?.text).toContain('ВЫБРАТЬ?');
    expect(view.actions[0]?.text).toContain('Часовой');
    expect(view.actions[0]?.tone).toBe('good');
    expect(view.actions).toHaveLength(2);
  });

  it('выбор из одних не-миньонов советы не вытесняет', () => {
    const withSpells: TavernAdvice = {
      ...tavern,
      choice: [
        {
          option: { entityId: 1, cardId: 'A' },
          name: 'Дар',
          value: null,
          reason: 'не миньон — оценить не берёмся',
        },
      ],
    };
    const view = buildView(input({ tavern: withSpells }), cards);
    expect(view.actions[0]?.text).not.toContain('ВЫБРАТЬ?');
  });

  it('план на несколько розыгрышей заменяет отдельные строки «разыграть»', () => {
    const playRec = (id: number, score: number): Recommendation => ({
      action: 'play',
      minion: minion(id),
      score,
      cost: 0,
      requiresSlot: false,
      sellFirst: null,
      reason: 'из руки',
    });
    const withPlan: TavernAdvice = {
      ...tavern,
      recommendations: [playRec(11, 20), playRec(12, 15), ...tavern.recommendations.slice(1)],
      playPlan: [
        { minion: minion(11), magnetizeTo: null, sellFirst: null, score: 20 },
        { minion: minion(12), magnetizeTo: minion(101), sellFirst: null, score: 15 },
      ],
    };
    const view = buildView(input({ tavern: withPlan }), cards);

    expect(view.actions[0]?.text).toContain('ПО ПОРЯДКУ');
    expect(view.actions[0]?.text).toContain('примагнитить к');
    // Отдельные «разыграть» свёрнуты в одну строку плана.
    expect(view.actions.filter((a) => a.text.includes('РАЗЫГРАТЬ'))).toHaveLength(1);
  });

  it('идущий счёт показывается вместо прошлого совета', () => {
    const view = buildView(
      input({ thinking: true, position: { kind: 'advice', advice: advice(), opponent: opponent() } }),
      cards,
    );

    // Показать старый совет как действующий — это ровно тот случай, когда
    // игрок делает ход по числам, которых уже нет.
    expect(view.position?.text).toBe('считаю расстановку…');
    expect(view.position?.tone).toBe('muted');
  });

  it('брошенный счёт виден, а не молчит', () => {
    const view = buildView(input({ position: { kind: 'dropped' } }), cards);
    expect(view.position?.text).toContain('брошен');
  });

  it('отсутствие картинки противника объясняется', () => {
    const view = buildView(
      input({ position: { kind: 'noOpponent', opponent: opponent({ source: 'unseen', usable: false }) } }),
      cards,
    );
    expect(view.position?.text).toContain('ещё не видели');
  });

  it('свежий совет показывается как совет', () => {
    const view = buildView(
      input({ position: { kind: 'advice', advice: advice(), opponent: opponent() } }),
      cards,
    );

    expect(view.position?.tone).toBe('good');
    expect(view.position?.text).toContain('+6.2 п.п.');
    expect(view.position?.text).not.toContain('устарела');
  });

  it('совет по устаревшей картинке помечается', () => {
    const view = buildView(
      input({
        position: { kind: 'advice', advice: advice(), opponent: opponent({ staleTurns: 13 }) },
      }),
      cards,
    );

    // Числа против борда 13-ходовой давности вырождаются: в фикстурах там
    // выходит 100% побед против того, чего давно нет.
    expect(view.position?.tone).toBe('warn');
    expect(view.position?.text).toContain('устарела');
  });
});
