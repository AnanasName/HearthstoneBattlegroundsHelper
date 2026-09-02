/**
 * Арена выбирающих: чей ход лучше по ближайшему бою.
 *
 *   npm run spike:arena
 *
 * Это ЗАМЕР, а не вердикт: он ничего не принимает и не отвергает, а отвечает
 * на два вопроса, которые в проекте не мерились ни разу. Первый — сколько
 * вообще можно выиграть на выборе покупки (потолок: оракул против игрока).
 * Второй — где на этой шкале стоит советник и где стоит «жирное тело», то есть
 * то единственное, во что вырождается ΔV модели замера 1: из семи её признаков
 * покупка меняет ровно один, `log1p(статы борда)`, а все пять относительных
 * признаков замера 3 не меняются вовсе — ΔV там тождественный ноль.
 *
 * Числа отсюда — материал для предрегистрации замера «модель выбирает ход
 * лучше игрока». Сам такой замер требует выбирающего-модели, которой пока
 * не существует; см. docs/ml.md.
 *
 * Оговорки, обязательные к чтению вместе с числами, — в `chooserArena.ts`:
 * мерка слепа к экономике, а игрок покупает как раз экономику и племя.
 */
import { createBattleSimulator } from '../battle/simulator.js';
import { loadCardIndex } from '../../data/cards.js';
import { CURRENT_BUILD_PARTS, readFixtureGame } from '../../data/fixtureGames.js';
import {
  CHOOSER_NAMES,
  contrastAgainstPlayer,
  contrastBetween,
  measureArena,
  type ArenaRow,
  type ArenaSkips,
  type ChooserName,
} from './chooserArena.js';

/**
 * Партии патч-группы целиком. До 02.09.2026 это был свой список
 * (`CURRENT_BUILD_PARTS` плюс part27–part35), потому что общий обрывался
 * на part26; теперь общий список и есть 4..35, а сегменты part35 читает
 * `readFixtureGame`. Разводка по загрязнению печатается отдельно.
 */
const PARTS = CURRENT_BUILD_PARTS;

function pad(value: number, width: number, digits = 2): string {
  return value.toFixed(digits).padStart(width);
}

function printContrasts(label: string, perGame: readonly (readonly ArenaRow[])[]): void {
  const points = perGame.reduce((sum, rows) => sum + rows.length, 0);
  const games = perGame.filter((rows) => rows.length > 0).length;
  console.log(`\n─── ${label}: партий ${String(games)}, точек ${String(points)} ───`);
  if (points === 0) return;
  const ceiling = contrastAgainstPlayer(perGame, 'oracle').mean;
  console.log('  выбирающий      D̄ против игрока      SD      SE     МРЭ   доля потолка  вывод');
  for (const name of CHOOSER_NAMES) {
    if (name === 'player') continue;
    const c = contrastAgainstPlayer(perGame, name);
    const verdict =
      c.mean > c.mde ? 'ВЫШЕ МРЭ' : c.mean < -c.mde ? 'НИЖЕ МРЭ (хуже игрока)' : 'внутри шума';
    // Доля потолка осмысленна только у выбирающих, играющих по доступному
    // знанию: у оракула она единица по определению, у случайного бессмысленна.
    const share =
      ceiling > 0 &&
      (name === 'live3' || name === 'liveAll' || name === 'liveBudget' || name === 'advisor')
        ? `${pad((100 * c.mean) / ceiling, 8, 0)}%`
        : '        —';
    console.log(
      `  ${name.padEnd(12)} ${pad(c.mean, 10)} п.п. ${pad(c.sd, 8)} ${pad(c.se, 7)} ${pad(c.mde, 7)}   ${share}     ${verdict}`,
    );
  }
  // Главные вопросы правки — парные контрасты МЕЖДУ выбирающими: игрок
  // здесь ни при чём, и парность снимает разброс самих точек.
  const pairs: readonly (readonly [ChooserName, ChooserName, string])[] = [
    ['live3', 'advisor', 'что даёт досчёт как он есть'],
    ['liveAll', 'live3', 'РАСШИРЕНИЕ: все кандидаты вместо трёх'],
    ['liveBudget', 'live3', 'расширение при ТОМ ЖЕ бюджете времени'],
    ['liveRich', 'liveAll', 'втрое больше симуляций на кандидата'],
    ['liveRich', 'live3', 'все кандидаты И втрое точнее'],
    ['oracle', 'live3', 'сколько потолка НЕ добирает досчёт'],
  ];
  for (const [a, b, label] of pairs) {
    const c = contrastBetween(perGame, a, b);
    const verdict =
      c.mean > c.mde ? 'ВЫШЕ МРЭ' : c.mean < -c.mde ? 'НИЖЕ МРЭ (хуже)' : 'внутри шума';
    console.log(
      `  ${(a + ' − ' + b).padEnd(22)} ${pad(c.mean, 6)} п.п.` +
        ` (SE ${pad(c.se, 5)}, МРЭ ${pad(c.mde, 5)}) — ${verdict.padEnd(15)} ${label}`,
    );
  }

  // Сколько раз выбирающие вообще РАЗОШЛИСЬ: контраст, стоящий на трёх
  // расхождениях, — это не «эффект мал», а «данных нет».
  const flat = perGame.flat();
  const differs = (a: keyof ArenaRow['picks'], b: keyof ArenaRow['picks']): number =>
    flat.filter((r) => r.picks[a] !== r.picks[b]).length;
  console.log(
    `  расхождений выборов: live3≠советник ${String(differs('live3', 'advisor'))}` +
      `, liveAll≠live3 ${String(differs('liveAll', 'live3'))}` +
      `, liveBudget≠liveAll ${String(differs('liveBudget', 'liveAll'))}` +
      `, liveRich≠liveAll ${String(differs('liveRich', 'liveAll'))}` +
      `, оракул≠live3 ${String(differs('oracle', 'live3'))}` +
      ` (точек ${String(flat.length)})`,
  );
}

function main(): void {
  const cards = loadCardIndex();
  const simulator = createBattleSimulator();

  const perGame: ArenaRow[][] = [];
  const parts: number[] = [];
  const totalSkips: ArenaSkips = {
    notBuyFirst: 0,
    buyOffShop: 0,
    noSpending: 0,
    noBattle: 0,
    noChoice: 0,
    noSacrifice: 0,
  };
  let advisorSilent = 0;

  for (const part of PARTS) {
    const text = readFixtureGame(part);
    if (text === null) {
      console.log(`part${String(part)}: лога нет, пропуск`);
      continue;
    }
    const report = measureArena(text, { cards, simulator });
    perGame.push([...report.rows]);
    parts.push(part);
    advisorSilent += report.advisorSilent;
    for (const key of Object.keys(totalSkips) as (keyof ArenaSkips)[]) {
      (totalSkips as Record<keyof ArenaSkips, number>)[key] += report.skips[key];
    }

    const oracle = report.rows.reduce((s, r) => s + (r.scores.oracle - r.scores.player), 0);
    console.log(
      `part${String(part).padEnd(2)}  точек ${String(report.rows.length).padStart(2)}` +
        `  потолок ${pad(report.rows.length === 0 ? 0 : oracle / report.rows.length, 6, 1)} п.п.`,
    );
  }

  const flat = perGame.flat();
  console.log(`\n═══ ВЫБОРКА ═══`);
  console.log(`партий: ${String(perGame.filter((r) => r.length > 0).length)}, точек: ${String(flat.length)}`);
  console.log('отсев точек решения по причинам:');
  console.log(`  первым тратил не покупку:        ${String(totalSkips.notBuyFirst)}`);
  console.log(`  покупка не из показанной витрины: ${String(totalSkips.buyOffShop)}`);
  console.log(`  в тот ход не тратил вовсе:        ${String(totalSkips.noSpending)}`);
  console.log(`  боя следом нет:                   ${String(totalSkips.noBattle)}`);
  console.log(`  выбора не было (одна по карману): ${String(totalSkips.noChoice)}`);
  console.log(`  борд полон, продать некого:       ${String(totalSkips.noSacrifice)}`);
  console.log(`советник не назвал покупки из кандидатов: ${String(advisorSilent)} точек`);

  const zero = flat.filter((r) => r.spread < 0.05).length;
  console.log(
    `\nточек, где выбор не решает ничего (спред < 0.05 п.п.): ${String(zero)}` +
      ` (${(flat.length === 0 ? 0 : (100 * zero) / flat.length).toFixed(1)}%)`,
  );
  const decisive = flat.filter((r) => r.spread >= 0.05);
  if (decisive.length > 0) {
    console.log(
      `средний спред на остальных: ${pad(decisive.reduce((s, r) => s + r.spread, 0) / decisive.length, 5, 2)} п.п.`,
    );
  }

  const withTarget = flat.filter((r) => r.liveHadTarget);
  const times = withTarget.map((r) => r.liveAllMs).sort((a, b) => a - b);
  console.log(
    `\nживой досчёт: цель была на ${String(withTarget.length)} точках из ${String(flat.length)}` +
      ` (на остальных он молчит и остаётся эвристика)`,
  );
  if (times.length > 0) {
    const boards = withTarget.map((r) => r.liveBoards);
    console.log(
      `  бордов в поле: медиана ${String(boards.sort((a, b) => a - b)[Math.floor(boards.length / 2)])}` +
        `, максимум ${String(Math.max(...boards))}`,
    );
    console.log(
      `  время досчёта ВСЕХ кандидатов: медиана ${String(times[Math.floor(times.length / 2)])} мс` +
        `, 90-й процентиль ${String(times[Math.floor(times.length * 0.9)])} мс` +
        `, максимум ${String(times[times.length - 1])} мс`,
    );
  }

  printContrasts('ВСЕ ТОЧКИ', perGame);
  printContrasts(
    'только там, где у досчёта БЫЛА цель',
    perGame.map((rows) => rows.filter((r) => r.liveHadTarget)),
  );

  // Заранее объявленные страты — не подвыборки задним числом.
  printContrasts(
    'полный борд (жертву назначало правило)',
    perGame.map((rows) => rows.filter((r) => r.boardFull)),
  );
  printContrasts(
    'неполный борд (жертвы нет вовсе)',
    perGame.map((rows) => rows.filter((r) => !r.boardFull)),
  );
  printContrasts(
    'part4–part26: мерка УЧАСТВОВАЛА в отборе правил советника',
    perGame.map((rows, i) => (parts[i]! <= 26 ? rows : [])),
  );
  // Вечером 02.09 `validate:tavern` по этим партиям прогнан ВПЕРВЫЕ (список
  // партий дошёл до part35), но правил по его числам не принято ни одного —
  // клетка чиста до первой такой правки, и тогда эту страту надо перечитать
  // как «была чистой на момент замера», а не как «чистая».
  printContrasts(
    'part27–part35: по ним правила советника не отбирались',
    perGame.map((rows, i) => (parts[i]! >= 27 ? rows : [])),
  );

  console.log(
    '\nЧитать вместе с оговоркой: мерка — ожидаемый исход ОДНОГО ближайшего боя,' +
      '\nи она слепа к экономике, следующим ходам и композиции (part16/18/22/25).' +
      '\nПортрет игрока по замеру 2 — «покупает племя 0.60 и тир 0.20, статы 0»,' +
      '\nто есть покупает он ровно то, чего эта мерка не видит. Разрыв «оракул' +
      '\nминус игрок» — потолок ближайшего боя, а НЕ мера того, как он играет,' +
      '\nи в места он не переводится: урон соперника мерка не считает.',
  );
}

main();
