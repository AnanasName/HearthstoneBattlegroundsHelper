import { describe, expect, it } from 'vitest';

import type { PositionAdvice } from '../../../src/advisors/position/advisor.js';
import { chooseAdvice, poolCandidates } from '../../../src/advisors/position/merge.js';
import type { Candidate } from '../../../src/advisors/position/search.js';
import { scoreOf, type Estimate } from '../../../src/advisors/position/score.js';
import type { Minion } from '../../../src/state/types.js';

/** Оценка счётчиками: побед из симуляций, остальное — поражения. */
function estimate(won: number, sims: number): Estimate {
  return {
    sims,
    won,
    tied: 0,
    lost: sims - won,
    wonLethal: 0,
    lostLethal: 0,
    damageWon: 0,
    damageLost: 0,
  };
}

function candidate(key: string, e: Estimate): Candidate {
  return { key, board: [] as readonly Minion[], estimate: e, score: scoreOf(e, 'winRate') };
}

/** Совет поиска: важны только `top` и `current`, остальное — обвязка. */
function advice(top: readonly Candidate[], current: Candidate): PositionAdvice {
  return {
    top,
    current,
    improves: top[0] !== undefined && top[0].key !== current.key,
    gain: 0,
    winGain: 0,
    rallyNote: null,
    report: {
      top,
      current,
      evaluated: top.length,
      simulations: 0,
      exhaustive: false,
      space: { size: 1, total: 1, distinct: 1 },
    },
    elapsedMs: 0,
  };
}

const CURRENT = 'abc';

describe('совокупные оценки кандидатов', () => {
  it('складывает симуляции одного ключа по разным поискам', () => {
    const a = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(50, 100)));
    const b = advice([candidate('bca', estimate(70, 100))], candidate(CURRENT, estimate(55, 100)));
    const pooled = poolCandidates([a, b]);
    expect(pooled.get('bca')).toMatchObject({ sims: 200, won: 130 });
    expect(pooled.get(CURRENT)).toMatchObject({ sims: 200, won: 105 });
  });

  it('текущую расстановку внутри одного поиска считает ОДИН раз', () => {
    // Она лежит и в top, и в current одной и той же оценкой: сложить их
    // значило бы удвоить её симуляции и дать ей незаслуженный вес.
    const current = candidate(CURRENT, estimate(50, 100));
    const one = advice([candidate('bca', estimate(60, 100)), current], current);
    expect(poolCandidates([one]).get(CURRENT)).toMatchObject({ sims: 100, won: 50 });
  });

  it('кандидата, которого видел один поиск из трёх, не выбрасывает', () => {
    const seen = advice([candidate('cab', estimate(80, 100))], candidate(CURRENT, estimate(50, 100)));
    const blind = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(50, 100)));
    const pooled = poolCandidates([seen, blind, blind]);
    expect(pooled.get('cab')).toMatchObject({ sims: 100, won: 80 });
  });
});

describe('выбор совета по совокупной улике', () => {
  it('сложенные симуляции меняют порядок: одиночный замер уступает подтверждённому', () => {
    // «bca» видели оба поиска: 50 и 60 из 100, вместе 110 из 200 — 55 %.
    // «cab» видел один: 52 из 100. По оценке ПЕРВОГО поиска впереди «cab»
    // (52 против 50), по сложенной — «bca».
    const lucky = advice(
      [candidate('cab', estimate(52, 100)), candidate('bca', estimate(50, 100))],
      candidate(CURRENT, estimate(40, 100)),
    );
    const steady = advice(
      [candidate('bca', estimate(60, 100))],
      candidate(CURRENT, estimate(40, 100)),
    );
    const choice = chooseAdvice([lucky, steady], 'winRate');
    expect(choice?.key).toBe('bca');
    expect(choice?.pooled.sims).toBe(200);
  });

  /**
   * Предел этой защиты, зафиксированный числом.
   *
   * Складываются СЧЁТЧИКИ, а сравниваются ДОЛИ, поэтому расстановка,
   * которую видел один поиск из двух, сохраняет своё везение целиком:
   * 62 из 100 — это 62 %, и они бьют 110 из 200. Уверенность в этих числах
   * разная (стандартная ошибка 4.9 против 3.5 п.п.), а сравнение её
   * не замечает.
   *
   * Это и есть «максимум по шумным оценкам» — ровно то, ради чего в поиске
   * заведены финальные раунды с равным добором. Лечится либо добором
   * симуляций финалистам до равного числа, либо сравнением по нижней границе
   * доверия. Что из этого окупается, решает замер против эталона, а не спор;
   * пока тест держит поведение честным, чтобы правка была видна.
   */
  it('ПОКА НЕ ЛЕЧИТ: крупное везение одиночного замера перевешивает', () => {
    const lucky = advice(
      [candidate('cab', estimate(62, 100)), candidate('bca', estimate(50, 100))],
      candidate(CURRENT, estimate(40, 100)),
    );
    const steady = advice(
      [candidate('bca', estimate(60, 100))],
      candidate(CURRENT, estimate(40, 100)),
    );
    const choice = chooseAdvice([lucky, steady], 'winRate');
    expect(choice?.key).toBe('cab');
    expect(choice?.pooled.sims).toBe(100);
  });

  it('при равной сумме выигрывает согласие поисков', () => {
    const first = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    const same = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    const alone = advice([candidate('cab', estimate(120, 200))], candidate(CURRENT, estimate(40, 100)));
    // «bca»: 120 из 200 = 60 %. «cab»: 120 из 200 = 60 %. Суммы равны,
    // но «bca» назвали два поиска из трёх.
    const choice = chooseAdvice([first, same, alone], 'winRate');
    expect(choice?.key).toBe('bca');
    expect(choice?.agreed).toBe(2);
  });

  it('отдаёт номер САМОГО РАННЕГО поиска с этой расстановкой', () => {
    // Иначе ответ зависел бы от того, какой воркер финишировал первым.
    const one = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    const two = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    expect(chooseAdvice([one, two], 'winRate')?.index).toBe(0);
  });

  it('поиск без рекомендации в выборе не участвует', () => {
    const empty = advice([], candidate(CURRENT, estimate(40, 100)));
    const real = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    expect(chooseAdvice([empty, real], 'winRate')?.index).toBe(1);
  });

  it('советов не было вовсе — выбирать нечего', () => {
    expect(chooseAdvice([], 'winRate')).toBeNull();
    expect(chooseAdvice([advice([], candidate(CURRENT, estimate(40, 100)))], 'winRate')).toBeNull();
  });

  it('уценка на неуверенность переворачивает близкий случай', () => {
    // «cab» видел один поиск: 56 из 100, ошибка 5.0 п.п. «bca» видели двое:
    // 110 из 200, ошибка 3.5 п.п. По точечной оценке впереди «cab» (56 > 55),
    // по нижней границе — «bca» (51.5 > 51.0).
    const lucky = advice(
      [candidate('cab', estimate(56, 100)), candidate('bca', estimate(50, 100))],
      candidate(CURRENT, estimate(40, 100)),
    );
    const steady = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    expect(chooseAdvice([lucky, steady], 'winRate')?.key).toBe('cab');
    expect(chooseAdvice([lucky, steady], 'winRate', { z: 1 })?.key).toBe('bca');
  });

  it('уценка НЕ переворачивает крупную разницу — и не должна', () => {
    // 62 из 100 против 110 из 200: разрыв 7 п.п. при ошибках 4.9 и 3.5.
    // Чтобы его снять, понадобилось бы больше пяти сигм, а такой кандидат
    // лучше не по везению. Уценка лечит близкие случаи, а не любые.
    const lucky = advice(
      [candidate('cab', estimate(62, 100)), candidate('bca', estimate(50, 100))],
      candidate(CURRENT, estimate(40, 100)),
    );
    const steady = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    expect(chooseAdvice([lucky, steady], 'winRate', { z: 1 })?.key).toBe('cab');
  });

  it('порядок поисков ответа не меняет', () => {
    const a = advice([candidate('bca', estimate(60, 100))], candidate(CURRENT, estimate(40, 100)));
    const b = advice([candidate('cab', estimate(70, 100))], candidate(CURRENT, estimate(40, 100)));
    const c = advice([candidate('bca', estimate(58, 100))], candidate(CURRENT, estimate(40, 100)));
    const forward = chooseAdvice([a, b, c], 'winRate');
    const backward = chooseAdvice([c, b, a], 'winRate');
    expect(forward?.key).toBe(backward?.key);
    expect(forward?.pooled.sims).toBe(backward?.pooled.sims);
  });
});
