/**
 * Замер: вредит ли ПРОВОКАЦИЯ носителю ралли?
 *
 *   npm run spike:taunt
 *
 * ## Зачем
 *
 * part21 (ход 5): план советовал купить Expert Aviator («Rally: Summon the
 * highest-Attack minion from your hand for this combat only») и повесить
 * на него два «Slimy Shield» — каждый даёт +1/+1 И ПРОВОКАЦИЮ. Игрок
 * возразил: у миньона ралли, и провокация на нём «кажется, не лучшая идея».
 *
 * Довод у возражения читаемый: ралли срабатывает, КОГДА НОСИТЕЛЬ АТАКУЕТ,
 * а провокация уводит на него все чужие удары — носитель рискует не дожить
 * до своего хода. Но ровно так же читается и довод против: провокация
 * достаётся телу, которое и так самое крупное, а размен телами — то,
 * ради чего его покупают. Такое различают замером, а не мнением: у нас
 * есть симулятор, который ралли-призыв МОДЕЛИРУЕТ (`expert-aviator.js`),
 * и все партии текущего билда (`CURRENT_BUILD_PARTS`, сейчас 32).
 *
 * Замер стал возможен только вместе с передачей РУКИ в симулятор (part21):
 * без неё ралли-призыв не срабатывал вовсе, и любая цифра про носителя
 * ралли была бы цифрой про голое тело.
 *
 * ## Предрегистрация — объявлено ДО прогона
 *
 * **Вопрос.** Хуже ли ближайший бой, когда провокацию получает носитель
 * ралли, а не другое тело борда?
 *
 * **Точки.** Все точки решения таверны (`readTavernTurns`) фикстур билда
 * 248348, где на борде есть миньон с механикой `BACON_RALLY` БЕЗ провокации,
 * есть хотя бы одно другое тело и есть цель боя (следующий противник или
 * поле виденных бордов). Носитель ралли берётся крупнейший, «другое тело» —
 * крупнейшее из остальных.
 *
 * **Мера.** Две пары, обе парные по точкам:
 *
 *  - ОСНОВНАЯ, чистая: +1/+1 в обеих ветвях достаётся ОДНОМУ И ТОМУ ЖЕ
 *    носителю ралли, а провокация — либо ему же, либо другому телу.
 *    Так меняется ровно одно — куда встала провокация, — и именно это
 *    называет игрок.
 *  - ВСПОМОГАТЕЛЬНАЯ, практическая: заклинание целиком (+1/+1 и провокация)
 *    идёт либо на носителя ралли, либо на другое тело. Это настоящий выбор
 *    цели, но он смешивает провокацию с переносом статов, поэтому вердикт
 *    выносится не по нему.
 *
 * Исход точки — победа плюс половина ничьей, 2000 симуляций на ветвь,
 * зерно фиксировано, поле бордов делится поровну (как в живом режиме).
 *
 * **Приёмка.** Правило «провокация не вешается на носителя ралли» вносится,
 * если среднее ОСНОВНОЙ пары отрицательно и по модулю превышает две
 * стандартные ошибки. Иначе правила нет: советник целится как прежде,
 * а ответ игроку — «польза не показана», с числом и порогом рядом.
 * Минимальный различимый эффект печатается вместе с результатом, чтобы
 * «не нашли» нельзя было спутать с «не могли найти».
 *
 * **Оговорки, тоже до прогона.**
 *  - меряется только БЛИЖАЙШИЙ бой, а провокация и статы остаются навсегда;
 *  - точка решения снята в начале хода, а заклинание играется в конце —
 *    борд к тому моменту бывает больше;
 *  - «+1/+1 и провокация» взято от Slimy Shield (part16, part21); другие
 *    заклинания с провокацией дают другие статы, и на них результат
 *    переносится по смыслу, а не по замеру;
 *  - у части носителей ралли эффект срабатывает от СВОЕЙ атаки, у части —
 *    от атаки любого своего миньона с ралли; замер их не разделяет.
 */
import { loadCardIndex, type CardIndex } from '../../data/cards.js';
import type { Minion } from '../../state/types.js';
import { endOfTurnAuraGains, withEndOfTurnAuras } from '../battle/endOfTurn.js';
import { toBattleInfo, withPlayerBoard } from '../battle/mapper.js';
import { createBattleSimulator } from '../battle/simulator.js';
import { battleQuestion } from '../position/advisor.js';
import { withSeededRandom } from '../position/rng.js';
import { summarize } from './statAnalysis.js';
import { readTavernTurns } from './turns.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';

const FIXTURES = CURRENT_BUILD_PARTS;

const SIMULATIONS = 2000;
const SEED = 20_260_817;

function isRally(m: Minion, cards: CardIndex): boolean {
  return cards.info(m.cardId)?.mechanics.includes('BACON_RALLY') === true;
}

function stats(m: Minion): number {
  return (m.attack ?? 0) + (m.health ?? 0);
}

/** Тот же борд, но названному миньону добавлены статы и/или провокация. */
function patched(
  board: readonly Minion[],
  buffed: Minion,
  taunted: Minion,
): readonly Minion[] {
  return board.map((m) => {
    const withStats =
      m.entityId === buffed.entityId
        ? {
            ...m,
            attack: (m.attack ?? 0) + 1,
            health: (m.health ?? 1) + 1,
            maxHealth: m.maxHealth === null ? null : m.maxHealth + 1,
          }
        : m;
    return withStats.entityId === taunted.entityId ? { ...withStats, taunt: true } : withStats;
  });
}

interface Point {
  readonly turn: number;
  /** Основная пара: провокация носителю ралли минус провокация другому телу. */
  readonly pure: number;
  /** Вспомогательная: всё заклинание на носителя ралли минус на другое тело. */
  readonly whole: number;
}

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const points: Point[] = [];
  let skipped = 0;

  for (const part of FIXTURES) {
    const text = readFixtureGame(part);
    if (text === null) continue;
    const turns = readTavernTurns(text);
    let used = 0;

    for (const { state } of turns) {
      const rallies = state.board.filter((m) => isRally(m, cards) && !m.taunt);
      const others = state.board.filter((m) => !isRally(m, cards));
      const question = battleQuestion(state);
      if (rallies.length === 0 || others.length === 0 || question === null) {
        skipped += 1;
        continue;
      }
      const rally = rallies.reduce((a, b) => (stats(b) > stats(a) ? b : a));
      const other = others.reduce((a, b) => (stats(b) > stats(a) ? b : a));

      const auraGains = endOfTurnAuraGains(state.board, simulator.cards);
      const bases = question.setups.map((s) => toBattleInfo(s, 1));
      const per = Math.max(1, Math.floor(SIMULATIONS / bases.length));

      const run = (buffed: Minion, taunted: Minion): number => {
        const board = withEndOfTurnAuras(patched(state.board, buffed, taunted), auraGains);
        let sum = 0;
        for (const [i, base] of bases.entries()) {
          const r = withSeededRandom(SEED + i, () =>
            simulator.run(withPlayerBoard(base, board), per),
          );
          sum += r.wonPercent + r.tiedPercent / 2;
        }
        return sum / bases.length;
      };

      points.push({
        turn: state.turn,
        pure: run(rally, rally) - run(rally, other),
        whole: run(rally, rally) - run(other, other),
      });
      used += 1;
    }

    console.log(`${`part${String(part)}`.padEnd(8)} точек ${String(used).padStart(3)}`);
  }

  if (points.length === 0) {
    console.log('точек не нашлось');
    return;
  }

  const pure = summarize(points.map((p) => p.pure));
  const whole = summarize(points.map((p) => p.whole));

  console.log('\n═══ итог ═══');
  console.log(`  точек решения:            ${String(pure.n)} (пропущено ${String(skipped)})`);
  console.log('\n  ОСНОВНАЯ пара (двигается только провокация, статы у носителя ралли):');
  console.log(`    ненулевых разностей:    ${String(pure.moved)}`);
  console.log(`    среднее:                ${pure.mean.toFixed(3)} п.п.`);
  console.log(`    стандартная ошибка:     ${pure.se.toFixed(3)} п.п.`);
  console.log(`    минимальный различимый: ${(2 * pure.se).toFixed(3)} п.п. (порог приёмки)`);
  console.log('\n  ВСПОМОГАТЕЛЬНАЯ пара (заклинание целиком, вердикт по ней НЕ выносится):');
  console.log(`    ненулевых разностей:    ${String(whole.moved)}`);
  console.log(`    среднее:                ${whole.mean.toFixed(3)} п.п.`);
  console.log(`    минимальный различимый: ${(2 * whole.se).toFixed(3)} п.п.`);

  console.log(
    `\n  ВЕРДИКТ: ${
      pure.mean < 0 && Math.abs(pure.mean) > 2 * pure.se
        ? 'провокация носителю ралли ВРЕДИТ — правило вносится'
        : pure.mean > 0 && Math.abs(pure.mean) > 2 * pure.se
          ? 'провокация носителю ралли ПОЛЕЗНА — правило не вносится, и обратного тоже'
          : 'разницы не видно — правила нет, цель провокации остаётся прежней'
    }`,
  );
  // Диагностика, НЕ предрегистрированная и на вердикт не влияющая: на
  // большинстве точек обе ветви дают тождественный исход (борд решает бой
  // и без провокации). Печатается, чтобы среднее по всем точкам нельзя
  // было прочесть как «эффект мал», когда он просто редко бывает виден:
  // у парной разности с нулями среднее и ошибка сжимаются вместе, и
  // отношение — то же самое.
  const movedOnly = summarize(points.map((p) => p.pure).filter((v) => Math.abs(v) > 0.05));
  console.log(
    `\n  диагностика (не предрегистрирована): по ${String(movedOnly.n)} точкам, где ветви ` +
      `разошлись, среднее ${movedOnly.mean.toFixed(3)} п.п. при пороге ${(2 * movedOnly.se).toFixed(3)}`,
  );
  console.log(
    '\n  Оговорки — в шапке файла: считается только ближайший бой, точка\n' +
      '  решения снята в начале хода, статы «+1/+1» взяты от Slimy Shield.',
  );
}

main();
