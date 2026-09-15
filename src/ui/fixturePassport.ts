/**
 * Паспорта партий: что лежит в логе, прежде чем делать из него фикстуру.
 *
 *   npm run fixture:passport                          последние 5 сессий клиента игры
 *   npm run fixture:passport -- --all                 все сессии
 *   npm run fixture:passport -- part49                фикстура по номеру
 *   npm run fixture:passport -- <сессия|Power.log> --frame=13:53
 *   npm run fixture:passport -- <сессия|Power.log> --game=1 --write=part52
 *
 * `--frame` называет партию, в которую попадает кадр игрока. `--write`
 * вырезает выбранную партию байт в байт в `data/fixtures/partN/game.log`
 * и отказывается, если партия не Battlegrounds, не доиграна или каталог
 * уже существует (`--force` снимает первые две проверки, но не третью).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadCardIndex } from '../data/cards.js';
import { readFixtureGame } from '../data/fixtureGames.js';
import { detectLogsRoot } from '../watcher/installDir.js';
import { parseClock } from './logSlice.js';
import { gameOfFrame, passportsOf, type GamePassport } from './passport.js';

const RECENT_SESSIONS = 5;

interface Source {
  readonly label: string;
  readonly text: string;
}

function flag(argv: readonly string[], name: string): string | null {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
}

function sessionsIn(root: string, all: boolean): Source[] {
  const sessions = readdirSync(root)
    .filter((d) => /^Hearthstone_\d{4}_/.test(d) && existsSync(join(root, d, 'Power.log')))
    .sort();
  return (all ? sessions : sessions.slice(-RECENT_SESSIONS)).map((d) => ({
    label: `сессия ${d}`,
    text: readFileSync(join(root, d, 'Power.log'), 'utf8'),
  }));
}

function resolveSources(ref: string | undefined, all: boolean): Source[] {
  if (ref === undefined) return sessionsIn(detectLogsRoot(), all);
  const numbered = /^(?:part)?(\d+)$/i.exec(ref);
  if (numbered !== null) {
    const text = readFixtureGame(Number(numbered[1]));
    if (text === null) throw new Error(`у part${numbered[1] ?? ''} нет лога в data/fixtures`);
    return [{ label: `фикстура part${numbered[1] ?? ''}`, text }];
  }
  if (!existsSync(ref)) throw new Error(`нет такого пути: ${ref}`);
  if (statSync(ref).isDirectory()) {
    const power = join(ref, 'Power.log');
    if (existsSync(power)) return [{ label: `сессия ${ref}`, text: readFileSync(power, 'utf8') }];
    return sessionsIn(ref, all);
  }
  return [{ label: ref, text: readFileSync(ref, 'utf8') }];
}

function problems(p: GamePassport): string[] {
  const list: string[] = [];
  if (!p.battlegrounds) list.push(`не Battlegrounds (${p.gameType ?? '?'})`);
  if (!p.finished) list.push('НЕ ДОИГРАНА: место текущее, а не итоговое (урок part38)');
  if (p.reconnect) list.push('начинается с переподключения');
  return list;
}

function main(): number {
  const argv = process.argv.slice(2);
  const ref = argv.find((a) => !a.startsWith('--'));
  const all = argv.includes('--all');
  const frameRaw = flag(argv, 'frame');
  const frame = frameRaw === null ? null : parseClock(frameRaw);
  if (frameRaw !== null && frame === null) {
    console.log(`--frame ждёт часы ЧЧ:ММ или ЧЧ:ММ:СС, а получил «${frameRaw}»`);
    return 1;
  }
  const writeTo = flag(argv, 'write');
  const gameRaw = flag(argv, 'game');

  const sources = resolveSources(ref, all);
  if (sources.length === 0) {
    console.log('сессий с Power.log не нашлось');
    return 1;
  }
  const cards = loadCardIndex();
  let hits = 0;

  for (const source of sources) {
    const passports = passportsOf(source.text);
    const framed = frame === null ? null : gameOfFrame(passports, frame);
    console.log(`\n${source.label}: партий ${String(passports.length)}`);
    for (const p of passports) {
      const hero = p.heroCardId === null ? '—' : (cards.info(p.heroCardId)?.name ?? p.heroCardId);
      const mark = framed === p.index ? `   ← кадр ${frameRaw ?? ''}` : '';
      console.log(
        `  #${String(p.index)}  ${p.start} … ${p.end}  ${p.gameType ?? 'режим ?'}  билд ${String(p.buildNumber ?? '—')}` +
          `  ${hero}  место ${String(p.place ?? '—')}  ходов таверны ${String(p.tavernTurns)}${mark}`,
      );
      for (const problem of problems(p)) console.log(`      ${problem}`);
    }
    if (framed !== null) hits += 1;
    if (frame !== null && framed === null) console.log(`  кадр ${frameRaw ?? ''} ни в одну партию этого лога не попадает`);

    if (writeTo !== null) {
      if (sources.length !== 1) {
        console.log('\n--write режет одну сессию: назовите её путём, а не каталогом логов');
        return 1;
      }
      const index = gameRaw === null ? (passports.length === 1 ? 1 : null) : Number(gameRaw);
      const chosen = passports.find((p) => p.index === index);
      if (chosen === undefined) {
        console.log(`\nв логе ${String(passports.length)} партий — назовите одну через --game=N`);
        return 1;
      }
      const issues = problems(chosen).filter((x) => !x.startsWith('начинается'));
      if (issues.length > 0 && !argv.includes('--force')) {
        console.log(`\nпартия #${String(chosen.index)} не годится в фикстуру: ${issues.join('; ')} — --force, если это намеренно`);
        return 1;
      }
      const part = /^(?:part)?(\d+)$/i.exec(writeTo);
      if (part === null) {
        console.log(`--write ждёт номер фикстуры вида part52, а получил «${writeTo}»`);
        return 1;
      }
      const dir = join('data', 'fixtures', `part${part[1] ?? ''}`);
      if (existsSync(dir)) {
        console.log(`\n${dir} уже существует — фикстуру не перезаписываю`);
        return 1;
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'game.log'), source.text.slice(chosen.from, chosen.to), 'utf8');
      console.log(`\nпартия #${String(chosen.index)} записана в ${join(dir, 'game.log')}`);
    }
  }

  return frame !== null && hits === 0 ? 2 : 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
