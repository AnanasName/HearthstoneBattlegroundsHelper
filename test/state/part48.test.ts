import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  heroPowerGoldenRule,
  heroPowerReady,
} from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part48Game } from '../fixtures.js';

/**
 * part48 — Рено Джексон (07.09.2026). Пунктов у игрока два, и они про
 * РАЗНОЕ молчание.
 *
 * Первый — про ветви модального миньона: «не показало лучший вариант при
 * розыгрыше карты» (Кратерный старатель, ход 7). Второй — про силу героя:
 * «снова не видел силу героя, так как не рекомендовал её нажать».
 *
 * Тест держит фактуру лога отдельно от чтения: сначала то, что игра
 * написала, потом то, что советник из этого делает, и отдельно — границы,
 * где он молчит и почему.
 */
describe('part48: сила «один раз за партию» и ветви кровавых самоцветов', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part48Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  /** Состояние на момент времени — срезом лога (метод part40, part43–part46). */
  const at = (until: string): GameState => {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      lines.push(line);
    }
    return reduceLog(lines.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  it('герой — Рено, сила бесплатна, активна с первого хода и не под замком', () => {
    const hero = decisionPoint(1).hero;
    expect(hero?.heroPowerCardId).toBe('TB_BaconShop_HP_046');
    // Тега COST у неё нет вовсе — как у Хроми (part13) и Инге (part45).
    expect(hero?.heroPowerCost).toBeNull();
    expect(hero?.heroPowerHasActivate).toBe(true);
    expect(hero?.heroPowerLocked).toBe(false);
    expect(hero?.heroPowerDisabled).toBe(false);
    // Ровно то, из-за чего молчание было незаметным: по всем признакам,
    // которые правила читали, сила ДОСТУПНА — молчал разбор текста.
    expect(cards.info('TB_BaconShop_HP_046')?.text ?? '').toMatch(/make a\s+friendly minion Golden/i);
  });

  /**
   * Фактура «одного раза за партию» — из лога. Тег `HERO_POWER_DISABLED`
   * ставится нажатием и НЕ снимается, тогда как `EXHAUSTED` возвращается
   * в ноль со сменой хода: без первого потраченная сила выглядит готовой.
   */
  it('нажатие одно, и после него сила запрещена до конца партии', () => {
    const presses = text
      .split(/\r?\n/)
      .filter(
        (l) =>
          l.includes('GameState.DebugPrintPower') &&
          l.includes('BLOCK_START BlockType=PLAY') &&
          l.includes('cardId=TB_BaconShop_HP_046'),
      );
    expect(presses).toHaveLength(1);
    expect(presses[0]).toMatch(/13:29:04/);

    // Состояние ПОСЛЕ нажатия: тег запрета стоит, а исчерпанность игра
    // уже сняла — и по ней одной сила числилась бы готовой.
    const after = decisionPoint(23).hero;
    expect(after?.heroPowerDisabled).toBe(true);
    expect(after?.heroPowerExhausted).toBe(false);
    expect(after?.heroPowerUsedThisTurn).toBe(false);
    expect(heroPowerReady(after!)).toBe(false);
  });

  /**
   * Что делает превращение — тоже из лога: прибавка равна РАЗНИЦЕ базовых
   * статов (5/5 против золотых 10/10), а накопленные усиления остаются.
   */
  it('золотым делается цель нажатия, и статы растут на базовые', () => {
    const line = text
      .split(/\r?\n/)
      .find((l) => l.includes('CHANGE_ENTITY') && l.includes('CardID=BG31_809_G'));
    expect(line).toBeDefined();
    expect(cards.info('BG31_809')?.attack).toBe(5);
    expect(cards.info('BG31_809_G')?.attack).toBe(10);
  });

  it('правило называет силу и цель, а после нажатия молчит', () => {
    // До нажатия сила по-настоящему доступна, и правило её называет.
    const before = heroPowerGoldenRule(decisionPoint(21), { cards });
    expect(before).not.toBeNull();
    expect(before?.action).toBe('heroPower');
    expect(before?.cost).toBe(0);
    expect(before?.targetMinion).not.toBeNull();
    expect(before?.grantsGolden).toBeDefined();
    expect(before?.reason).toMatch(/сделать золотым/);
    // Заряд один на партию, и совет обязан сказать это словами.
    expect(before?.reason).toMatch(/один на партию/);

    // После нажатия — молчание, и держит его именно тег запрета.
    expect(heroPowerGoldenRule(decisionPoint(23), { cards })).toBeNull();
  });

  /**
   * ГРАНИЦА, ради которой считается цена спешки: заряд один, и ранний ход
   * тратит его на тело, которое к концу партии не стоит ничего. Правило
   * молчит первые пять точек решения и заговаривает во второй половине —
   * там же, где нажал и сам игрок (13:29, ход 21).
   */
  it('на ранних ходах правило молчит, а во второй половине партии говорит', () => {
    for (const turn of [1, 3, 5, 7, 9]) {
      expect(heroPowerGoldenRule(decisionPoint(turn), { cards }), `ход ${String(turn)}`).toBeNull();
    }
    for (const turn of [11, 15, 21]) {
      expect(
        heroPowerGoldenRule(decisionPoint(turn), { cards }),
        `ход ${String(turn)}`,
      ).not.toBeNull();
    }
  });

  it('бесплатный шаг попадает в план хода', () => {
    const plan = spendPlan(decisionPoint(15), { cards });
    const step = plan.steps.find((s) => s.recommendation.action === 'heroPower');
    expect(step).toBeDefined();
    expect(step?.goldBefore).toBe(step?.goldAfter);
    // Шаг прозрачен: цель на гипотетическом борде уже золотая.
    const target = step?.recommendation.targetMinion;
    const after = step?.stateAfter.board.find((m) => m.entityId === target?.entityId);
    expect(after?.golden).toBe(true);
  });

  /**
   * ПУНКТ 1. Кадр игрока снят между покупкой (13:12:53) и розыгрышем
   * (13:13:01), поэтому точкой решения он не воспроизводится: там золото
   * ещё целое, а Кратерный старатель — в витрине.
   */
  it('на кадре игрока обе ветви названы числами, а не прочерками', () => {
    const state = at('13:13:00');
    expect(state.turn).toBe(7);
    expect(state.gold).toBe(0);
    expect(state.hand.map((m) => m.cardId)).toContain('BG31_320');

    const advice = adviseTavern(state, { cards });
    const play = advice?.recommendations.find((r) => r.action === 'play');
    expect(play).toBeDefined();
    const labels = (play?.spellBranches ?? []).map((b) => `${b.name} ${b.label}`);
    expect(labels).toHaveLength(2);
    // Самоцветы считаются точно: две карты по +1/+1 — это +4 статов.
    expect(labels[0]).toBe('Take the Gems +4 статов сейчас');
    // А усиление будущих самоцветов остаётся без очков, но со словами.
    expect(labels[1]).toMatch(/каждому будущему самоцвету/);
    expect(play?.reason).toMatch(/сколько их будет, советник не считает/);
  });

  it('размер самоцвета берётся из состояния, а не из константы', () => {
    // У нас надбавок нет всю партию — самоцвет базовый.
    expect(decisionPoint(7).globalInfo.bloodGemAttackBuff).toBeNull();
    // А игра надбавку пишет и доводит до восьми — у соперника в этой же
    // партии: считать самоцвет вечными «+1/+1» значило бы ошибаться в разы.
    expect(text).toMatch(/BACON_BLOODGEMBUFFATKVALUE value=8/);
  });

  it('ветвь, которую сыграл игрок, названа первой в подписи', () => {
    // `SubOption=0` — первая ветвь, «Take the Gems» (13:13:01).
    const played = reduceLog(text).actions.find(
      (a) => a.type === 'play' && a.cardId === 'BG31_320',
    );
    expect(played?.subOption).toBe(0);
  });
});
