/**
 * Замер: КОМУ вешать усиление — крупнейшему телу или носителю вихря?
 *
 *   npm run spike:bufftarget
 *
 * ## Зачем
 *
 * Правило цели усиления с part17 одно: «крупнейший свой из тех, кого
 * не собираются продавать». Оно ни разу не мерилось — мерилось только
 * РАЗДЕЛЕНИЕ статов у равных ветвей (`spike:buff`), то есть «+3/+1 или
 * +1/+3», а не «на кого».
 *
 * Повод — пункт игрока по part40 (ход 11): советник вешал Repair Job
 * +4/+9 на Locked-up Mutineer 6/3 (крупнейшее тело), игрок сказал, что
 * «на существо с божественным щитом выглядит разумнее». Замер против
 * ФАКТИЧЕСКОГО борда соперника следующего боя (8000 симуляций) дал
 * порядок, которого не ждала ни одна из сторон:
 *
 *   Crackling Cyclone 2/1 (щит, вихрь)   43.2 %   ← вихрь
 *   Locked-up Mutineer 6/3               22.5 %   ← совет советника
 *   Aureate Laureate 2/2 (зол, щит)      13.2 %   ← ход игрока
 *   без усиления                          0.0 %
 *
 * Одна точка правилом не становится — отсюда этот замер.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Если усиление фиксированного размера отдать носителю ВИХРЯ
 * вместо крупнейшего тела, что даёт лучший исход БЛИЖАЙШЕГО боя?
 *
 * **Довод у ветви-кандидата арифметический, а не вкусовой:** вихрь бьёт
 * дважды, значит атакующая половина усиления считается в бою два раза.
 * Щит в кандидат НЕ входит намеренно: он усиление не умножает, а на точке
 * part40 щит без вихря (Aureate Laureate) проиграл и крупнейшему телу.
 * Одно ключевое слово — одна причина, которую можно назвать вслух.
 *
 * **Точки.** Все точки решения таверны (`readTavernTurns`) партий
 * `CURRENT_BUILD_PARTS`, где есть цель боя и обе ветви правила называют
 * РАЗНЫЕ цели. Ограничение на расхождение объявлено здесь заранее и
 * по той же причине, по которой `spike:taunt` читается с оговоркой:
 * на совпадающих целях разность тождественно нулевая, и включать их
 * значило бы топить эффект в нулях. Сколько точек отсеяно совпадением —
 * печатается рядом: «узко» должно быть видно, а не спрятано.
 *
 * **Мера.** Парная разность на точку: исход (победа + половина ничьей)
 * с целью-вихрем минус исход с крупнейшим телом. Усиление — фиксированное
 * +4/+4: сумма поровну, чтобы ответ не двигало РАЗДЕЛЕНИЕ статов, у
 * которого свой замер. 2000 симуляций на сторону, зерно фиксировано,
 * поле делится поровну — как в живом режиме.
 *
 * **Приёмка.** `buffTargetPreference: 'windfury'` вносится, если среднее
 * ПОЛОЖИТЕЛЬНО и превышает две стандартные ошибки. Отрицательное среднее
 * выше порога — довод сохранить нынешнее правило и записать это числом.
 * Иначе — `'stats'` остаётся, и «не нашли» печатается вместе с минимальным
 * различимым эффектом, чтобы его нельзя было спутать с «не могли найти».
 *
 * **Оговорки, тоже до прогона.**
 *  - меряется только БЛИЖАЙШИЙ бой, а усиление остаётся навсегда;
 *  - точка решения снята в начале хода, а заклинание играется в конце —
 *    борд к тому моменту бывает больше (та же оговорка, что у `spike:buff`);
 *  - +4/+4 взято как нейтральный размер; на сильно перекошенные усиления
 *    результат переносится по смыслу, а не по замеру;
 *  - оракул (лучшая цель по симулятору) печатается ДИАГНОСТИКОЙ и в приёмку
 *    не входит: он знает исход боя, а советник — нет.
 *
 * ## Что показал прогон 05.09.2026 (записано ПОСЛЕ, вердикт не менялся)
 *
 * **НЕ ДОКАЗАНО.** 55 точек расхождения на 37 партиях, среднее −0.126 п.п.
 * при пороге приёмки 0.321 (две стандартные ошибки, SE 0.160). Знак
 * формально в пользу нынешнего правила, но величина втрое меньше порога —
 * читать это надо как «разницы не видно», а не как «крупнейший лучше».
 * `buffTargetPreference` остаётся `'stats'`.
 *
 * Три вещи, без которых число прочтётся неправильно.
 *
 * ПЕРВОЕ. Эффективная выборка крошечная: у 44 точек из 55 разность
 * ТОЖДЕСТВЕННО нулевая — обе цели дают один и тот же исход боя. Это тот же
 * случай, что у `spike:hand` (там 16 расхождений из 118): ближайший бой
 * чаще всего не замечает, кому достались четыре стата.
 *
 * ВТОРОЕ. Потолок тоже мал: лучшая цель ПО СИМУЛЯТОРУ выше «крупнейшего»
 * всего на 0.324 п.п. при ошибке 0.155 — то есть ВСЁ правило цели, вместе
 * взятое, стоит примерно треть процентного пункта в среднем. При этом
 * на точке жалобы (part40, ход 11) разрыв был 43.2 % против 22.5 %.
 * Огромная дисперсия при почти нулевом среднем — не парадокс, а описание:
 * цель усиления решает бой редко, но когда решает — решает целиком.
 *
 * ТРЕТЬЕ, и это про сам прибор. ПЕРВЫЙ прогон дал 43 точки и был ВЫБРОШЕН
 * не из-за чисел, а потому что мерил не то: ветвь-кандидат сужала пул ПОСЛЕ
 * фильтра кандидатов в продажу, а `weakestOwn` на part40 назначает жертвой
 * ровно Crackling Cyclone — носителя вихря. Замер тогда дал по part40 РОВНО
 * НОЛЬ точек, то есть не видел случая, ради которого затевался. Ветвь
 * перенесена выше фильтра, part40 дала 5 точек, и только после этого числа
 * стали относиться к вопросу. Урок общий: у замера, сравнивающего два
 * правила, надо СНАЧАЛА проверить, что на спорной точке правила расходятся.
 */
import { loadCardIndex } from '../../data/cards.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';
import type { Minion } from '../../state/types.js';
import { endOfTurnAuraGains, withEndOfTurnAuras } from '../battle/endOfTurn.js';
import { toBattleInfo, withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import { withSeededRandom } from '../position/rng.js';
import { buffTarget } from './advisor.js';
import { DEFAULT_TAVERN_RULES } from './rules.js';
import { summarize, type SpikeSummary } from './statAnalysis.js';
import { readTavernTurns } from './turns.js';

const FIXTURES = CURRENT_BUILD_PARTS;

/** Размер усиления замера: сумма поровну — разделение мерит `spike:buff`. */
const BUFF = { attack: 4, health: 4 } as const;
const SIMULATIONS = 2000;
const SEED = 20_260_905;

const STATS_RULES = { ...DEFAULT_TAVERN_RULES, buffTargetPreference: 'stats' as const };
const WINDFURY_RULES = { ...DEFAULT_TAVERN_RULES, buffTargetPreference: 'windfury' as const };

function buffed(board: readonly Minion[], target: Minion): Minion[] {
  return board.map((m) =>
    m.entityId === target.entityId
      ? {
          ...m,
          attack: (m.attack ?? 0) + BUFF.attack,
          health: (m.health ?? 1) + BUFF.health,
          maxHealth: m.maxHealth === null ? null : m.maxHealth + BUFF.health,
        }
      : m,
  );
}

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const diffs: { readonly turn: number; readonly diff: number }[] = [];
  const ceiling: number[] = [];
  let sameTarget = 0;
  let noBattle = 0;

  for (const part of FIXTURES) {
    const text = readFixtureGame(part);
    if (text === null) continue;
    let used = 0;

    for (const { state } of readTavernTurns(text)) {
      const question = battleQuestion(state);
      if (question === null || state.board.length === 0) {
        noBattle += 1;
        continue;
      }
      const byStats = buffTarget(state, { cards }, STATS_RULES);
      const byWindfury = buffTarget(state, { cards }, WINDFURY_RULES);
      if (byStats === null || byWindfury === null) {
        noBattle += 1;
        continue;
      }
      if (byStats.entityId === byWindfury.entityId) {
        sameTarget += 1;
        continue;
      }

      const auraGains = endOfTurnAuraGains(state.board, simulator.cards);
      const bases = question.setups.map((s) => toBattleInfo(s, 1));
      const per = Math.max(1, Math.floor(SIMULATIONS / bases.length));

      const run = (target: Minion): number => {
        const board = withEndOfTurnAuras(buffed(state.board, target), auraGains);
        let sum = 0;
        for (const [i, base] of bases.entries()) {
          const r = withSeededRandom(SEED + i, () =>
            simulator.run(withPlayerBoard(base, board), per),
          );
          sum += r.wonPercent + r.tiedPercent / 2;
        }
        return sum / bases.length;
      };

      const stats = run(byStats);
      const windfury = run(byWindfury);
      diffs.push({ turn: state.turn, diff: windfury - stats });

      // Диагностика: потолок — лучшая цель ПО СИМУЛЯТОРУ среди всего борда.
      // В приёмку не входит: он знает исход боя, советник — нет.
      const best = Math.max(...state.board.map((m) => run(m)));
      ceiling.push(best - stats);
      used += 1;
    }

    console.log(`${`part${String(part)}`.padEnd(8)} расхождений ${String(used).padStart(3)}`);
  }

  if (diffs.length === 0) {
    console.log('\nточек расхождения не нашлось — правило «крупнейший» и вихрь совпадают всюду');
    return;
  }

  const all: SpikeSummary = summarize(diffs.map((d) => d.diff));
  const top: SpikeSummary = summarize(ceiling);

  console.log('\n═══ итог ═══');
  console.log(`  точек расхождения:        ${String(all.n)}`);
  console.log(`  цели совпали (отсеяно):   ${String(sameTarget)}`);
  console.log(`  без цели боя (отсеяно):   ${String(noBattle)}`);
  console.log(`  из них разность ненулевая: ${String(all.moved)}`);
  console.log(`  среднее (вихрь минус крупнейший): ${all.mean.toFixed(3)} п.п.`);
  console.log(`  стандартная ошибка:       ${all.se.toFixed(3)} п.п.`);
  console.log(`  минимальный различимый:   ${(2 * all.se).toFixed(3)} п.п. (порог приёмки)`);
  console.log(
    `\n  ВЕРДИКТ: ${
      Math.abs(all.mean) > 2 * all.se
        ? all.mean > 0
          ? "вешать на носителя ВИХРЯ (buffTargetPreference: 'windfury')"
          : "правило «крупнейший» лучше — оставить 'stats' и записать это числом"
        : "разницы не видно — buffTargetPreference остаётся 'stats'"
    }`,
  );
  console.log(
    `\n  диагностика (не предрегистрирована): потолок — лучшая цель по симулятору\n` +
      `  выше «крупнейшего» на ${top.mean.toFixed(3)} п.п. при ошибке ${top.se.toFixed(3)};\n` +
      '  это цена ВСЕГО правила цели, а не одной ветви с вихрем.',
  );
  console.log(
    '\n  Оговорки — в шапке файла: только ближайший бой, точка решения снята\n' +
      '  в начале хода, усиление +4/+4 нейтрального размера.',
  );
}

main();
