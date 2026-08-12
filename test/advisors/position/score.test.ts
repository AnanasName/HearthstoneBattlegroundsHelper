import { describe, expect, it } from 'vitest';

import {
  distinguishable,
  mergeEstimates,
  netDamage,
  objectiveOf,
  scoreError,
  scoreOf,
  toEstimate,
  winRate,
  winRateError,
  type Estimate,
} from '../../../src/advisors/position/score.js';

function estimate(patch: Partial<Estimate> = {}): Estimate {
  return {
    sims: 100,
    won: 50,
    tied: 10,
    lost: 40,
    wonLethal: 5,
    lostLethal: 4,
    damageWon: 500,
    damageLost: 200,
    ...patch,
  };
}

describe('оценка расстановки', () => {
  it('складывается счётчиками, а не усреднением процентов', () => {
    const a = estimate({ sims: 100, won: 50, tied: 10, lost: 40 });
    const b = estimate({ sims: 900, won: 90, tied: 10, lost: 800 });
    const merged = mergeEstimates(a, b);

    expect(merged.sims).toBe(1000);
    expect(merged.won).toBe(140);
    // Среднее процентов дало бы (50% + 10%) / 2 = 30%, что втрое мимо:
    // прогоны разного размера имеют разный вес.
    expect(winRate(merged)).toBeCloseTo(0.14, 10);
  });

  it('сложение нейтрально к порядку и к пустой оценке', () => {
    const a = estimate();
    const b = estimate({ sims: 7, won: 3, tied: 0, lost: 4 });
    expect(mergeEstimates(a, b)).toEqual(mergeEstimates(b, a));
  });

  it('берёт из итога симулятора штуки, а не округлённые проценты', () => {
    const estimated = toEstimate({
      won: 7,
      tied: 1,
      lost: 2,
      wonLethal: 3,
      lostLethal: 1,
      damageWon: 70,
      damageLost: 8,
      // Проценты пакета округлены до десятой и подменяются на краях —
      // в оценку они не идут.
      wonPercent: 70,
      tiedPercent: 10,
      lostPercent: 20,
      wonLethalPercent: 30,
      lostLethalPercent: 10,
      averageDamageWon: 10,
      averageDamageLost: 4,
      damageWons: [],
      damageLosts: [],
      damageWonRange: { min: 0, max: 0 },
      damageLostRange: { min: 0, max: 0 },
    });

    expect(estimated.sims).toBe(10);
    expect(estimated.won).toBe(7);
    expect(estimated.damageWon).toBe(70);
  });

  it('ожидаемый размен здоровьем считается на все бои, а не на победные', () => {
    // 500 нанесено за победы, 200 получено за поражения, боёв сто.
    expect(netDamage(estimate())).toBeCloseTo(3, 10);
  });

  it('стандартная ошибка падает как корень из числа симуляций', () => {
    const few = estimate({ sims: 150, won: 75, tied: 0, lost: 75 });
    const many = estimate({ sims: 1500, won: 750, tied: 0, lost: 750 });
    expect(winRateError(few)).toBeCloseTo(0.0408, 3);
    expect(winRateError(many)).toBeCloseTo(0.0129, 3);
    expect(winRateError(few) / winRateError(many)).toBeCloseTo(Math.sqrt(10), 1);
  });

  it('пустая оценка не притворяется точной', () => {
    expect(winRateError({ ...estimate(), sims: 0 })).toBe(0.5);
  });

  it('ошибка считается по величине сравнения, а не по доле побед', () => {
    // Бой, который выиграть нельзя: решается только тем, свести ли вничью.
    const worse = estimate({ sims: 2000, won: 0, tied: 1948, lost: 52, wonLethal: 0, lostLethal: 0 });
    const better = estimate({ sims: 2000, won: 0, tied: 1982, lost: 18, wonLethal: 0, lostLethal: 0 });

    // По доле побед разницы нет вовсе — обе нулевые.
    expect(winRate(worse)).toBe(0);
    expect(winRate(better)).toBe(0);
    expect(winRateError(worse)).toBe(0);

    // А по величине сравнения она есть, и её видно.
    expect(scoreError(worse, 'winRate')).toBeGreaterThan(0);
    expect(distinguishable(worse, better, 'winRate')).toBe(true);
  });

  it('в безнадёжном бою разводящий довесок не выдаётся за улучшение', () => {
    // Все бои проиграны, различается только средний урон. Дисперсия исходов
    // здесь ровно ноль, и без отделения довеска порог значимости проходило
    // что угодно.
    const hopeless = estimate({ sims: 2000, won: 0, tied: 0, lost: 2000, damageWon: 0, damageLost: 20_000 });
    const alsoHopeless = estimate({ sims: 2000, won: 0, tied: 0, lost: 2000, damageWon: 0, damageLost: 19_000 });

    expect(distinguishable(hopeless, alsoHopeless, 'winRate')).toBe(false);
    // Упорядочить их всё же надо: выбирать из чего-то приходится.
    expect(scoreOf(alsoHopeless, 'winRate')).toBeGreaterThan(scoreOf(hopeless, 'winRate'));
    // А величина сравнения у них одинакова — выигрыша нет и показывать нечего.
    expect(objectiveOf(alsoHopeless, 'winRate')).toBe(objectiveOf(hopeless, 'winRate'));
  });

  it('для цели без известной ошибки проверка откатывается на исходы боя', () => {
    expect(scoreError(estimate(), 'netDamage')).toBeNull();

    const same = estimate({ sims: 2000, won: 1000, tied: 0, lost: 1000, damageWon: 2000, damageLost: 20_000 });
    const alsoSame = estimate({ sims: 2000, won: 1000, tied: 0, lost: 1000, damageWon: 2000, damageLost: 2000 });
    // Урон отличается в разы, но распределение исходов то же — значимости нет.
    expect(distinguishable(same, alsoSame, 'netDamage')).toBe(false);
  });

  it('различимость требует разницы больше двух ошибок разности', () => {
    const a = estimate({ sims: 150, won: 75, tied: 0, lost: 75 });
    // 4 п.п. разницы при ошибке разности около 5.8 п.п. — это шум.
    const near = estimate({ sims: 150, won: 81, tied: 0, lost: 69 });
    expect(distinguishable(a, near)).toBe(false);

    // Та же разница, но на десятикратном числе симуляций, уже видна.
    const aBig = estimate({ sims: 1500, won: 750, tied: 0, lost: 750 });
    const nearBig = estimate({ sims: 1500, won: 810, tied: 0, lost: 690 });
    expect(distinguishable(aBig, nearBig)).toBe(true);
  });

  it('цели ранжируют по-разному, и это видно на одном и том же наборе', () => {
    // Расстановка, которая чаще выигрывает, но проигрывает разгромно.
    const risky = estimate({ sims: 100, won: 55, tied: 0, lost: 45, lostLethal: 40, damageWon: 275, damageLost: 900 });
    // Расстановка, которая выигрывает реже, но и теряет меньше.
    const safe = estimate({ sims: 100, won: 45, tied: 15, lost: 40, lostLethal: 2, damageWon: 225, damageLost: 175 });

    expect(scoreOf(risky, 'winRate')).toBeGreaterThan(scoreOf(safe, 'winRate'));
    expect(scoreOf(safe, 'netDamage')).toBeGreaterThan(scoreOf(risky, 'netDamage'));
    expect(scoreOf(safe, 'survival')).toBeGreaterThan(scoreOf(risky, 'survival'));
  });

  it('ничья ценится выше поражения и ниже победы', () => {
    const win = estimate({ sims: 100, won: 100, tied: 0, lost: 0 });
    const tie = estimate({ sims: 100, won: 0, tied: 100, lost: 0 });
    const loss = estimate({ sims: 100, won: 0, tied: 0, lost: 100 });

    expect(scoreOf(win, 'winRate')).toBeGreaterThan(scoreOf(tie, 'winRate'));
    expect(scoreOf(tie, 'winRate')).toBeGreaterThan(scoreOf(loss, 'winRate'));
  });
});
