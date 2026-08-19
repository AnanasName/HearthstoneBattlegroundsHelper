import { describe, expect, it } from 'vitest';

import { createRng } from '../../src/advisors/tavern/statAnalysis.js';
import { createCardIndex } from '../../src/data/cards.js';
import {
  baseCardOf,
  buildInstances,
  candidateFeatures,
  evaluateImitationLogo,
  imitationVerdict,
  randomHitRate,
  shuffleLabels,
  tieAwareChance,
  tieAwareHit,
  type ImitationInstance,
} from '../../src/ml/imitation.js';
import type { DatasetGame } from '../../src/ml/dataset.js';
import { EMPTY_STATE, type GameState, type PlayerAction } from '../../src/state/types.js';
import { board, minion } from '../minions.js';

/**
 * Замер 2 — имитация покупок: сборка инстансов из записей с журналом,
 * парное обучение и вердикт. Предрегистрация — docs/ml.md.
 */

/** Справочник из голых объектов — как настоящий, но обозримый. */
const CARDS = createCardIndex([
  { id: 'CARD_101', name: 'Мурлок сто первый', techLevel: 2, races: ['MURLOC'], type: 'Minion', isBaconPool: true },
  { id: 'CARD_102', name: 'Зверь сто второй', techLevel: 3, races: ['BEAST'], type: 'Minion', isBaconPool: true },
  { id: 'CARD_103', name: 'Нейтрал сто третий', techLevel: 1, races: [], type: 'Minion', isBaconPool: true },
]);

function tavern(turn: number, patch: Partial<GameState> = {}): GameState {
  return { ...EMPTY_STATE, phase: 'tavern', turn, ...patch };
}

function gameOf(
  fileName: string,
  finalPlace: number,
  checkpoints: readonly { turn: number; state: GameState }[],
  actions: readonly PlayerAction[] | undefined,
): DatasetGame {
  return {
    fileName,
    finalPlace,
    record: {
      savedAt: '2026-08-19T00:00:00.000Z',
      buildNumber: 248348,
      heroCardId: 'H',
      finalPlace,
      checkpoints,
      ...(actions === undefined ? {} : { actions }),
    },
  };
}

const buy = (turn: number, entityId: number): PlayerAction => ({
  turn,
  type: 'buy',
  cardId: null,
  entityId,
});

describe('сборка инстансов имитации', () => {
  it('join по entityId: куплен показанный миньон, чужое посчитано вслух', () => {
    const state = tavern(3, {
      shop: board([101, 102, 103]),
      shopSpells: [
        { entityId: 900, cardId: 'SPELL_1', cost: 1, scriptData: [], unplayable: false },
      ],
    });
    const game = gameOf('a.json', 2, [{ turn: 3, state }], [
      buy(3, 101), // показанный миньон
      buy(3, 900), // заклинание витрины — не кандидат
      buy(3, 555), // после обновления: в показанной витрине такого нет
      { turn: 3, type: 'sell', cardId: 'CARD_101', entityId: 101 }, // не покупка
    ]);

    const built = buildInstances([game]);
    expect(built.instances).toHaveLength(1);
    expect([...(built.instances[0]?.boughtCardIds ?? [])]).toEqual(['CARD_101']);
    expect(built.instances[0]?.candidates).toHaveLength(3);
    expect(built.spellBuys).toBe(1);
    expect(built.offShopBuys).toBe(1);
  });

  it('покупка на другом ходу к чужой витрине не пришивается', () => {
    const cp1 = { turn: 1, state: tavern(1, { shop: board([101, 102]) }) };
    const cp3 = { turn: 3, state: tavern(3, { shop: board([201, 202]) }) };
    const game = gameOf('b.json', 4, [cp1, cp3], [buy(3, 201)]);

    const built = buildInstances([game]);
    // Ход 1 — без покупок из показанного; ход 3 — годный инстанс.
    expect(built.instances).toHaveLength(1);
    expect(built.instances[0]?.turn).toBe(3);
    expect(built.skippedNoShownBuys).toBe(1);
  });

  it('куплено всё и витрина из одного — не инстансы, а счётчики', () => {
    const all = gameOf('c.json', 1, [{ turn: 1, state: tavern(1, { shop: board([1, 2]) }) }], [
      buy(1, 1),
      buy(1, 2),
    ]);
    const single = gameOf('d.json', 1, [{ turn: 1, state: tavern(1, { shop: board([9]) }) }], [
      buy(1, 9),
    ]);
    const silent = gameOf('e.json', 5, [{ turn: 1, state: tavern(1, { shop: board([1, 2]) }) }], undefined);

    const built = buildInstances([all, single, silent]);
    expect(built.instances).toHaveLength(0);
    expect(built.skippedAllBought).toBe(1);
    expect(built.skippedFewCandidates).toBe(1);
    expect(built.gamesWithoutActions).toEqual(['e.json']);
  });

  it('покупки на ходах без точки решения считаются вслух, а не теряются', () => {
    const game = gameOf('m.json', 2, [{ turn: 3, state: tavern(3, { shop: board([1, 2]) }) }], [
      buy(3, 1),
      buy(5, 999), // ход 5 точки решения не имеет — пришить не к чему
      buy(7, 998),
    ]);
    const built = buildInstances([game]);
    expect(built.instances).toHaveLength(1);
    expect(built.buysOnMissingTurns).toBe(2);
    // Это не «вне витрины»: тот счётчик — про ходы С точкой решения.
    expect(built.offShopBuys).toBe(0);
  });

  it('золотая копия считается той же картой', () => {
    expect(baseCardOf('CARD_101_G')).toBe('CARD_101');
    const state = tavern(5, { shop: [minion(7, { cardId: 'CARD_101_G' }), minion(8)] });
    const game = gameOf('g.json', 3, [{ turn: 5, state }], [buy(5, 7)]);
    expect([...(buildInstances([game]).instances[0]?.boughtCardIds ?? [])]).toEqual(['CARD_101']);
  });
});

describe('признаки кандидата', () => {
  it('тир из справочника, статы живые, соплеменники и цена на месте', () => {
    const state = tavern(5, {
      board: [minion(11, { cardId: 'CARD_101' }), minion(12, { cardId: 'CARD_103' })],
    });
    const candidate = minion(1, { cardId: 'CARD_101', attack: 4, health: 6, golden: false });
    // Тир 2 из справочника; 10 статов; не золотой; на борде один мурлок
    // (копия и есть соплеменник), копия одна; цена — базовые 3 золота.
    expect(candidateFeatures(candidate, state, CARDS)).toEqual([2, 10, 0, 1, 1, 3]);
  });
});

describe('оценка LOGO имитации', () => {
  /** Игрок этого теста всегда покупает самое толстое тело. */
  function statsBuyerGame(name: string, finalPlace: number, seed: number): ImitationInstance[] {
    return [0, 1].map((k) => {
      const statsOf = [4 + ((seed + k) % 3), 8 + ((seed * 2 + k) % 4), 2];
      const shop = statsOf.map((s, i) =>
        minion(10 * k + i + 1, { cardId: `CARD_10${String(i + 1)}`, attack: s, health: s }),
      );
      const fattest = [...shop].sort((a, b) => (b.attack ?? 0) - (a.attack ?? 0))[0];
      return {
        gameName: name,
        finalPlace,
        turn: 2 * k + 1,
        state: tavern(2 * k + 1, { shop }),
        candidates: shop,
        boughtCardIds: new Set([baseCardOf(fattest?.cardId ?? '')]),
      };
    });
  }

  it('предсказуемый игрок выучивается до единицы, и советник-невпопад бит', () => {
    const instances = [1, 2, 3, 4, 5, 6].flatMap((i) =>
      statsBuyerGame(`g${String(i)}.json`, i, i),
    );
    // «Советник» всегда называет самого тощего — модель обязана его бить.
    const result = evaluateImitationLogo(instances, CARDS, 0, (inst) => {
      const thinnest = [...inst.candidates].sort(
        (a, b) => (a.attack ?? 0) - (b.attack ?? 0),
      )[0];
      return thinnest === undefined ? null : baseCardOf(thinnest.cardId);
    });
    expect(result.evals).toHaveLength(6);
    for (const e of result.evals) {
      expect(e.hitModel).toBe(1);
      expect(e.hitAdvisor).toBe(0);
    }
  });

  it('инстанс без выбора советника исключается из всех метрик и считается', () => {
    const instances = [1, 2, 3].flatMap((i) => statsBuyerGame(`g${String(i)}.json`, i, i));
    const first = instances[0];
    const result = evaluateImitationLogo(instances, CARDS, 0, (inst) =>
      inst === first ? null : baseCardOf(inst.candidates[0]?.cardId ?? ''),
    );
    expect(result.droppedNoAdvisor).toBe(1);
    expect(result.evals.find((e) => e.name === 'g1.json')?.instances).toBe(1);
  });

  it('random — аналитическая доля кандидатов с купленной картой', () => {
    const inst = statsBuyerGame('r.json', 1, 1)[0];
    expect(inst === undefined ? 0 : randomHitRate(inst)).toBeCloseTo(1 / 3, 9);
  });

  it('твины признаков: hit — доля купленных среди разделивших максимум', () => {
    // Две разные карты с тождественными признаками — модели их не развести,
    // и целый hit решал бы тай-брейк по позиции, а не модель.
    const shop = [
      minion(1, { cardId: 'CARD_101', attack: 5, health: 5 }),
      minion(2, { cardId: 'CARD_103', attack: 5, health: 5 }),
      minion(3, { cardId: 'CARD_102', attack: 2, health: 2 }),
    ];
    const inst: ImitationInstance = {
      gameName: 't.json',
      finalPlace: 1,
      turn: 1,
      state: tavern(1, { shop }),
      candidates: shop,
      boughtCardIds: new Set(['CARD_101']),
    };
    const byStats = (c: (typeof shop)[number]): number => (c.attack ?? 0) + (c.health ?? 0);
    expect(tieAwareHit(inst, byStats)).toBeCloseTo(0.5, 9);
  });

  it('шанс собственного выбора учитывает дубли карт в витрине', () => {
    // Две копии одной карты наверху: метко-независимый «куплена карта
    // случайного кандидата» даёт им шанс 2/3, а не 1/3, — сравнение
    // с randomHitRate здесь смещало бы нуль контроля.
    const shop = [
      minion(1, { cardId: 'CARD_101', attack: 5, health: 5 }),
      minion(2, { cardId: 'CARD_101', attack: 5, health: 5 }),
      minion(3, { cardId: 'CARD_102', attack: 2, health: 2 }),
    ];
    const inst: ImitationInstance = {
      gameName: 'c.json',
      finalPlace: 1,
      turn: 1,
      state: tavern(1, { shop }),
      candidates: shop,
      boughtCardIds: new Set(['CARD_102']),
    };
    const byStats = (c: (typeof shop)[number]): number => (c.attack ?? 0) + (c.health ?? 0);
    expect(tieAwareChance(inst, byStats)).toBeCloseTo(2 / 3, 9);
    expect(tieAwareHit(inst, byStats)).toBe(0);
  });

  it('фильтр обучения меняет модель: «имитация из побед» учится у топ-мест', () => {
    // Топ-места покупают статы, хвост таблицы — наоборот. Модель с фильтром
    // «места 1–3» обязана предсказывать топ-игрока и на вынесенной партии.
    const top = [1, 2, 3].flatMap((i) => statsBuyerGame(`top${String(i)}.json`, i, i));
    const bottom = [7, 8].flatMap((i) =>
      statsBuyerGame(`bot${String(i)}.json`, i, i).map((inst) => {
        const thinnest = [...inst.candidates].sort(
          (a, b) => (a.attack ?? 0) - (b.attack ?? 0),
        )[0];
        return { ...inst, boughtCardIds: new Set([baseCardOf(thinnest?.cardId ?? '')]) };
      }),
    );
    const all = [...top, ...bottom];
    const advisor = (inst: ImitationInstance): string =>
      baseCardOf(inst.candidates[2]?.cardId ?? '');

    // λ=1, как в основной ветке: без регуляризации коллинеарные тир
    // и статы дают неустойчивое разложение весов на крошечной синтетике.
    const filtered = evaluateImitationLogo(all, CARDS, 1, advisor, (i) => i.finalPlace <= 3);
    for (const e of filtered.evals.filter((e) => e.name.startsWith('top'))) {
      expect(e.hitModel).toBe(1);
    }
    for (const e of filtered.evals.filter((e) => e.name.startsWith('bot'))) {
      expect(e.hitModel).toBe(0);
    }
  });

  it('перемешивание меток детерминировано зерном', () => {
    const instances = [1, 2].flatMap((i) => statsBuyerGame(`g${String(i)}.json`, i, i));
    const a = shuffleLabels(instances, createRng(9));
    const b = shuffleLabels(instances, createRng(9));
    expect(a.map((x) => [...x.boughtCardIds])).toEqual(b.map((x) => [...x.boughtCardIds]));
    for (const x of a) expect(x.boughtCardIds.size).toBe(1);
  });
});

describe('вердикт замера 2', () => {
  const band = { p05: -0.08, p95: 0.07 };
  it('дословно по предрегистрации, включая «минус внутри полосы»', () => {
    expect(imitationVerdict(0.12, band, 0.06, 0.6, 0.3)).toBe('ПРИНЯТЬ');
    expect(imitationVerdict(-0.2, band, 0.06, 0.3, 0.3)).toBe('ОТВЕРГНУТЬ');
    expect(imitationVerdict(-0.03, band, 0.06, 0.3, 0.3)).toBe('НЕ ДОКАЗАНО');
    expect(imitationVerdict(0.04, band, 0.06, 0.6, 0.3)).toBe('НЕ ДОКАЗАНО');
    expect(imitationVerdict(0.12, band, 0.15, 0.6, 0.3)).toBe('НЕ ДОКАЗАНО');
    // Порог и полоса взяты, но random не бит — не доказано.
    expect(imitationVerdict(0.12, band, 0.06, 0.3, 0.35)).toBe('НЕ ДОКАЗАНО');
  });
});
