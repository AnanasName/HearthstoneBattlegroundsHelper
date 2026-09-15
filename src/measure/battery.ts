/**
 * Батарея замеров одной командой.
 *
 *   npm run battery                  полный прогон → data/measurements/*.json и docs/measurements.md
 *   npm run battery -- --parts=4-7   проверка правки на подмножестве → только терминал
 *   npm run battery -- --only=calibrate,validate:spend
 *   npm run battery -- --seeds=5     полоса шума: тот же код на зёрнах 1..5
 *   npm run battery -- --status      устарела ли батарея и какие партии вне списка
 *   npm run battery -- --allow-dirty прогон при незакоммиченном src/
 *
 * Зачем. Замеры гонялись по одному, вывод читался глазами, а числа
 * переписывались прозой в три файла документации. Батарея выбрасывалась
 * минимум трижды из-за того, что часть прогона успевала пройти на старом
 * коде (part39, part41, part44), а после партий part45–part50 не гонялась
 * вовсе — дорого. Здесь прогон привязан к коммиту, сохраняется данными
 * и сравнивается с прошлым сравнимым прогоном сам.
 *
 * Прогон отказывается стартовать при незакоммиченном `src/`: в общем дереве
 * работают соседние сессии, и число, снятое на чужих полуготовых правках,
 * не воспроизвести. Если сосед правит код, гонять из чистого worktree
 * (`git worktree add --detach <каталог> HEAD`, node_modules — связкой).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURRENT_BUILD_PARTS } from '../data/fixtureGames.js';
import { partsArg, seedArg } from './args.js';
import {
  comparable,
  durationLabel,
  noiseBand,
  renderMarkdown,
  type BatteryRun,
  type MeasurementRun,
  type NoiseBand,
} from './report.js';
import { parseResult } from './result.js';

interface Measurement {
  readonly name: string;
  readonly script: string;
  /** Принимает ли скрипт `--parts`: калибровка читает свои пути. */
  readonly takesParts: boolean;
}

/**
 * Что входит в батарею. Замер добавляется строкой здесь и вызовом
 * `emitResult` в конце своего скрипта — больше ничего не нужно.
 */
const MEASUREMENTS: readonly Measurement[] = [
  { name: 'validate:tavern', script: 'src/advisors/tavern/validate.ts', takesParts: true },
  { name: 'validate:spend', script: 'src/advisors/tavern/validateSpend.ts', takesParts: true },
  { name: 'calibrate', script: 'src/advisors/battle/calibrate.ts', takesParts: false },
];

const OUT_DIR = 'data/measurements';
const LOG_DIR = join(OUT_DIR, 'logs');
const QUICK_DIR = join(OUT_DIR, 'quick');
const REPORT_PATH = 'docs/measurements.md';
const TSX_CLI = 'node_modules/tsx/dist/cli.mjs';

function git(args: readonly string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

/**
 * Незакоммиченные пути в `src/`. Вывод porcelain не обрезается целиком:
 * у первой строки ведущий пробел — часть кода статуса (« M»), и общий trim
 * сдвигал её относительно остальных.
 */
function dirtySrc(): string[] {
  return execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
}

function flag(argv: readonly string[], name: string): string | null {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  return found === undefined ? null : found.slice(name.length + 3);
}

function loadRuns(dir: string): BatteryRun[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('noise_'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as BatteryRun)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

function loadNoise(parts: readonly number[]): NoiseBand | null {
  if (!existsSync(OUT_DIR)) return null;
  const bands = readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('noise_') && f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(OUT_DIR, f), 'utf8')) as NoiseBand)
    .filter((b) => b.parts.length === parts.length && b.parts.every((n, i) => n === parts[i]));
  return bands[bands.length - 1] ?? null;
}

function runScript(m: Measurement, seed: number, parts: readonly number[], full: boolean, logPath: string): Promise<MeasurementRun> {
  return new Promise((resolve) => {
    const args = [TSX_CLI, m.script, `--seed=${String(seed)}`];
    if (m.takesParts && !full) args.push(`--parts=${parts.join(',')}`);
    const started = Date.now();
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const log = createWriteStream(logPath);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      log.write(text);
      for (const match of text.matchAll(/═══ (part\d+)/g)) process.stdout.write(` ${match[1] ?? ''}`);
    });
    child.stderr.on('data', (chunk: Buffer) => log.write(chunk));
    child.on('close', (code) => {
      log.end();
      process.stdout.write('\n');
      resolve({
        exitCode: code ?? 1,
        durationSec: Math.round((Date.now() - started) / 1000),
        result: parseResult(stdout),
      });
    });
  });
}

function status(): number {
  const runs = loadRuns(OUT_DIR).filter((r) => r.full);
  const inList = new Set(CURRENT_BUILD_PARTS);
  const lowest = Math.min(...CURRENT_BUILD_PARTS);
  const fixtures = existsSync('data/fixtures')
    ? readdirSync('data/fixtures')
        .map((d) => /^part(\d+)$/.exec(d))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => Number(m[1]))
        .filter((n) => n > lowest && !inList.has(n))
        .sort((a, b) => a - b)
    : [];
  console.log(`список партий замеров: ${String(CURRENT_BUILD_PARTS.length)}, до part${String(Math.max(...CURRENT_BUILD_PARTS))}`);
  console.log(fixtures.length === 0 ? 'все фикстуры текущего билда в списке' : `фикстуры вне списка: ${fixtures.map((n) => `part${String(n)}`).join(', ')}`);
  const last = runs[runs.length - 1];
  if (last === undefined) {
    console.log('полных прогонов батареи ещё не было — `npm run battery`');
    return 0;
  }
  console.log(`последний полный прогон: ${last.startedAt.slice(0, 16).replace('T', ' ')}, коммит ${last.sha}, зерно ${String(last.seed)}`);
  let since = '?';
  try {
    since = git(['rev-list', '--count', `${last.sha}..HEAD`, '--', 'src/advisors', 'src/state', 'src/parser', 'src/data']);
  } catch {
    // коммита прогона нет в этой истории (перебазирование) — число неизвестно
  }
  console.log(`коммитов в советниках, редьюсере и данных с тех пор: ${since}`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--status')) return status();

  const dirty = dirtySrc();
  if (dirty.length > 0 && !argv.includes('--allow-dirty')) {
    console.log('в src/ есть незакоммиченные изменения — число с них не воспроизвести:');
    for (const line of dirty.slice(0, 12)) console.log(`  ${line}`);
    console.log('закоммитьте свои правки или гоняйте из чистого worktree; `--allow-dirty` — под свою ответственность');
    return 2;
  }

  const parts = partsArg(argv, CURRENT_BUILD_PARTS);
  const full = parts.length === CURRENT_BUILD_PARTS.length;
  const onlyRaw = flag(argv, 'only');
  const only = onlyRaw === null ? null : new Set(onlyRaw.split(','));
  const selected = MEASUREMENTS.filter((m) => only === null || only.has(m.name));
  if (selected.length === 0) {
    console.log(`нечего гонять: известны ${MEASUREMENTS.map((m) => m.name).join(', ')}`);
    return 1;
  }
  const seedsRaw = flag(argv, 'seeds');
  const seedCount = seedsRaw === null ? null : Number(seedsRaw);
  if (seedCount !== null && (!Number.isInteger(seedCount) || seedCount < 2)) {
    console.log(`--seeds ждёт целое число от двух: полоса шума по одному зерну не считается, а получено «${seedsRaw ?? ''}»`);
    return 1;
  }
  const seeds = seedCount === null ? [seedArg(argv)] : Array.from({ length: seedCount }, (_, i) => i + 1);

  const sha = git(['rev-parse', '--short', 'HEAD']);
  const outDir = full ? OUT_DIR : QUICK_DIR;
  mkdirSync(outDir, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  const runs: BatteryRun[] = [];
  for (const seed of seeds) {
    const startedAt = new Date().toISOString();
    const stamp = startedAt.slice(0, 16).replace(/[:T]/g, '-');
    const measurements: Record<string, MeasurementRun> = {};
    for (const m of selected) {
      process.stdout.write(`▶ ${m.name}, зерно ${String(seed)}, партий ${String(parts.length)}:`);
      const logPath = join(LOG_DIR, `${stamp}_${sha}_seed${String(seed)}_${m.name.replace(':', '-')}.txt`);
      const run = await runScript(m, seed, parts, full, logPath);
      measurements[m.name] = run;
      console.log(`  ${m.name}: ${durationLabel(run.durationSec)}, код ${String(run.exitCode)}${run.result === null ? ', ИТОГА НЕТ' : ''}`);
    }
    const run: BatteryRun = { startedAt, sha, dirty: dirty.length > 0, seed, parts, full, measurements };
    runs.push(run);
    writeFileSync(join(outDir, `${stamp}_${sha}_seed${String(seed)}.json`), `${JSON.stringify(run, null, 2)}\n`);
  }

  const current = runs[runs.length - 1] as BatteryRun;
  if (seedsRaw !== null) {
    const band = noiseBand(runs);
    if (band !== null && full) writeFileSync(join(OUT_DIR, `noise_${sha}.json`), `${JSON.stringify(band, null, 2)}\n`);
    console.log(`\nполоса шума по зёрнам ${seeds.join(', ')}${full ? ' записана' : ' (подмножество — не записана)'}`);
    for (const [name, row] of Object.entries(band?.sd ?? {})) {
      console.log(`  ${name}: ${Object.entries(row).map(([k, v]) => `${k} ±${v.toFixed(2)}`).join(', ')}`);
    }
  }

  const previous =
    loadRuns(outDir)
      .filter((r) => r.startedAt < current.startedAt && comparable(r, current) && r.full === current.full)
      .pop() ?? null;
  const report = renderMarkdown(current, previous, loadNoise(parts));
  if (full && seedsRaw === null) {
    writeFileSync(REPORT_PATH, report);
    console.log(`\nтаблица записана в ${REPORT_PATH}`);
  }
  console.log(`\n${report}`);

  return Object.values(current.measurements).some((m) => m.exitCode !== 0 || m.result === null) ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
