/**
 * Разбор партии в HTML: факты, предположения, лента ходов.
 *
 *   npm run postgame -- part73
 *   npm run postgame -- <Power.log | .Power.log.part | .Power.log.gz | папка сессии> [--game=N]
 *   npm run postgame -- --latest           последняя сессия в папке логов игры
 *
 * Ключи: `--game=N` — какая партия в логе (по умолчанию последняя
 * доигранная партия Battlegrounds), `--out=<папка>` — куда писать
 * (по умолчанию `homeDir/reports`), `--fast` — без расстановки и плана
 * (секунды вместо минут).
 *
 * Отчёт пишется файлом и открывается браузером: у сборки приложения
 * терминала нет, и в оверлей длинный список не помещается (D285).
 */
import { existsSync } from 'node:fs';

import { createBattleSimulator } from '../advisors/battle/simulator.js';
import { loadFieldBoards } from '../advisors/strength/boards.js';
import { REPORTS_DIR } from '../app/paths.js';
import { APP_VERSION } from '../app/version.js';
import { loadCardIndex } from '../data/cards.js';
import { readFixtureGame } from '../data/fixtureGames.js';
import { buildPostGameReport } from '../report/build.js';
import { pickGame, readLogText, sessionDateOf, sessionRefOf, simulatorVersion } from '../report/job.js';
import { writeReport } from '../report/store.js';
import { detectLogsRoot } from '../watcher/installDir.js';
import { findLatestPowerLog } from '../watcher/logPaths.js';

function flag(argv: readonly string[], name: string): string | null {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
}

interface Source {
  readonly ref: string;
  readonly text: string;
  readonly excludePart: number | null;
  /** Дата из имени сессии `Hearthstone_ГГГГ_ММ_ДД_…`. */
  readonly date: string | null;
}

function readSource(ref: string): Source {
  const numbered = /^(?:part)?(\d+)$/i.exec(ref);
  if (numbered !== null) {
    const part = Number(numbered[1]);
    const text = readFixtureGame(part);
    if (text === null) throw new Error(`у part${String(part)} нет лога в data/fixtures`);
    // Фикстура мерится без своих бордов в поле (`boardsOfTurn`).
    return { ref: `part${String(part)}`, text, excludePart: part, date: null };
  }
  if (!existsSync(ref)) throw new Error(`нет файла ${ref}`);
  const { text, file } = readLogText(ref);
  return { ref: sessionRefOf(file), text, excludePart: null, date: sessionDateOf(file) };
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let ref = argv.find((a) => !a.startsWith('--')) ?? null;
  if (argv.includes('--latest')) ref = findLatestPowerLog(detectLogsRoot());
  if (ref === null) {
    console.log('использование: npm run postgame -- <partN | путь к Power.log> [--game=N] [--fast] [--out=папка]');
    console.log('               npm run postgame -- --latest');
    return 1;
  }

  const source = readSource(ref);
  const wanted = flag(argv, 'game');
  const picked = pickGame(source.text, wanted === null ? null : Number(wanted));
  if (picked === null) {
    console.log('в логе нет такой партии');
    return 1;
  }
  const chosen = picked.passport;
  const gameIndex = picked.total > 1 ? chosen.index : null;
  const text = source.text.slice(chosen.from, chosen.to);
  console.log(
    `${source.ref}: партия ${String(chosen.index)} из ${String(picked.total)}, ${chosen.start}–${chosen.end}, место ${String(chosen.place ?? '?')}`,
  );

  const fast = argv.includes('--fast');
  const report = await buildPostGameReport(
    text,
    { cards: loadCardIndex(), simulator: createBattleSimulator(), field: loadFieldBoards() },
    {
      ref: source.ref,
      gameIndex,
      date: source.date,
      excludePart: source.excludePart,
      generatedAt: new Date().toISOString(),
      appVersion: APP_VERSION,
      simulatorVersion: simulatorVersion(),
      positioning: !fast,
      plan: !fast,
      onProgress: (m) => {
        process.stdout.write(`  ${m}\n`);
      },
    },
  );

  const written = writeReport(report, flag(argv, 'out') ?? REPORTS_DIR);
  console.log(
    `\nфактов ${String(report.facts.length)}, предположений ${String(report.assumptions.length)}, ${(report.elapsedMs / 1000).toFixed(0)} с`,
  );
  for (const f of report.facts) console.log(`  факт · ход таверны ${String(f.tavernTurn)} · ${f.title}`);
  console.log(`\nотчёт: ${written.htmlPath}\nвсе партии: ${written.indexPath}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
