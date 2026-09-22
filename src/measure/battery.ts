/**
 * Батарея замеров одной командой.
 *
 *   npm run battery                  полный прогон → data/measurements/*.json и docs/measurements.md
 *   npm run battery -- --parts=4-7   проверка правки на подмножестве → только терминал
 *   npm run battery -- --only=calibrate,validate:spend
 *   npm run battery -- --seeds=5     полоса шума: тот же код на зёрнах 1..5
 *   npm run battery -- --status      устарела ли батарея и какие партии вне списка
 *   npm run battery -- --allow-dirty прогон при незакоммиченном src/
 *   npm run battery -- --jobs=1      замеры друг за другом, как до 23.09.2026
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

import { CURRENT_BUILD_PARTS, fixtureLogPaths } from '../data/fixtureGames.js';
import { partsArg, seedArg } from './args.js';
import { runPool } from './pool.js';
import { shardName } from './shard.js';
import {
  comparable,
  durationLabel,
  noiseBand,
  renderMarkdown,
  type BatteryRun,
  type MeasurementRun,
  type NoiseBand,
} from './report.js';
import { parseResult, type MeasureResult } from './result.js';

interface Measurement {
  readonly name: string;
  readonly script: string;
  /** Принимает ли скрипт `--parts` номерами партий. */
  readonly takesParts: boolean;
  /**
   * Принимает ли скрипт ПУТИ к логам позиционными аргументами.
   *
   * Калибровка устроена так, и до 16.09.2026 батарея ей ничего не давала —
   * а её собственное умолчание это ОДНА партия (part4). Полный прогон
   * 16.09 это и показал: два первых замера шли по 30 минут на 49 партиях,
   * а калибровка закончилась за 6 секунд на ВОСЬМИ боях, и её «расхождение
   * 1.5 п.п. при Brier 0.003» относилось к одной партии, а не к корпусу.
   * Умолчание самого скрипта не тронуто: `npm run calibrate` остаётся
   * быстрой командой разработчика.
   */
  readonly takesPaths?: boolean;
  /**
   * Умеет ли скрипт считать свои партии куском (`--shard-out`) и склеивать
   * куски (`--shard-in`). Без этого замер гоняется одним процессом, как раньше.
   */
  readonly shardable?: boolean;
}

/**
 * Что входит в батарею. Замер добавляется строкой здесь и вызовом
 * `emitResult` в конце своего скрипта — больше ничего не нужно.
 */
const MEASUREMENTS: readonly Measurement[] = [
  { name: 'validate:tavern', script: 'src/advisors/tavern/validate.ts', takesParts: true, shardable: true },
  { name: 'validate:spend', script: 'src/advisors/tavern/validateSpend.ts', takesParts: true, shardable: true },
  { name: 'calibrate', script: 'src/advisors/battle/calibrate.ts', takesParts: false, takesPaths: true, shardable: true },
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

/**
 * Сколько замеров гонять одновременно.
 *
 * Умолчание — половина ядер, но не больше числа задач: каждый замер держит
 * свой снапшот карт (40 МБ JSON), и восемь процессов на шестнадцатиядерной
 * машине оставляют запас и памяти, и ядер под тесты соседней сессии.
 * `--jobs=1` возвращает прежний порядок «друг за другом».
 */
function jobsArg(argv: readonly string[]): number {
  const raw = flag(argv, 'jobs');
  if (raw === null) return Math.max(1, Math.floor(availableParallelism() / 2));
  const jobs = Number(raw);
  if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs ждёт целое число от единицы, а получил «${raw}»`);
  return jobs;
}

/**
 * Один запуск скрипта замера: либо замер целиком, либо кусок по партиям,
 * либо склейка кусков.
 */
interface Job {
  readonly m: Measurement;
  readonly parts: readonly number[];
  /** Файл, куда кусок складывает строки; `null` — не кусок. */
  readonly shardOut: string | null;
  /** Каталог кусков для склейки; `null` — не склейка. */
  readonly shardIn: string | null;
}

interface JobRun {
  readonly exitCode: number;
  readonly durationSec: number;
  readonly result: MeasureResult | null;
  /** Вывод процесса в порядке прихода — его пишут в лог замера целиком. */
  readonly output: string;
}

function jobArgs(job: Job, seed: number, full: boolean): string[] {
  const { m } = job;
  const args = [TSX_CLI, m.script, `--seed=${String(seed)}`];
  if (job.shardIn !== null) {
    // Склейке список партий нужен ради поля `parts` в итоге замера.
    args.push(`--parts=${job.parts.join(',')}`, `--shard-in=${job.shardIn}`);
    return args;
  }
  // Куску партии передаются ВСЕГДА, в том числе при полном прогоне: его
  // партия — одна, а умолчание скрипта — весь список.
  if (job.shardOut !== null) args.push(`--parts=${job.parts.join(',')}`, `--shard-out=${job.shardOut}`);
  else if (m.takesParts && !full) args.push(`--parts=${job.parts.join(',')}`);
  // Пути передаются ВСЕГДА, в том числе при полном прогоне: у скрипта,
  // читающего пути, умолчание — своё и узкое (см. `takesPaths`).
  if (m.takesPaths === true) args.push(...job.parts.flatMap((p) => fixtureLogPaths(p)));
  return args;
}

function runJob(job: Job, seed: number, full: boolean): Promise<JobRun> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, jobArgs(job, seed, full), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      output += text;
      // Отметка о партии — целой строкой с именем замера: задачи идут
      // одновременно, и дописывать их в одну строку значит смешать вывод.
      for (const match of text.matchAll(/═══ (part\d+)/g)) console.log(`  ${job.m.name} ${match[1] ?? ''}`);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        durationSec: Math.round((Date.now() - started) / 1000),
        result: parseResult(stdout),
        output,
      });
    });
  });
}

/**
 * Резать ли замер на куски по партиям. Смысл в этом есть, только если
 * партий больше одной и есть куда их разложить.
 */
function shardedByParts(m: Measurement, parts: readonly number[], jobs: number): boolean {
  return m.shardable === true && parts.length > 1 && jobs > 1;
}

/** Прогон всех замеров одного зерна. */
async function runSeed(
  selected: readonly Measurement[],
  parts: readonly number[],
  seed: number,
  full: boolean,
  jobs: number,
  stamp: string,
  sha: string,
): Promise<Record<string, MeasurementRun>> {
  const shardRoot = mkdtempSync(join(tmpdir(), 'hsbg-battery-'));
  const shardDir = (m: Measurement): string => join(shardRoot, m.name.replace(':', '-'));
  try {
    // Первая волна — счёт. Куски по партиям у тех замеров, что принимают
    // партии, и замер целиком у остальных; все в ОДНОЙ очереди, чтобы
    // длинный хвост одного замера считался рядом с кусками другого.
    const wave: Job[] = [];
    const mine = new Map<string, number[]>();
    for (const m of selected) {
      const indices: number[] = [];
      if (shardedByParts(m, parts, jobs)) {
        for (const [i, p] of parts.entries()) {
          indices.push(wave.length);
          wave.push({ m, parts: [p], shardOut: join(shardDir(m), shardName(i)), shardIn: null });
        }
      } else {
        indices.push(wave.length);
        wave.push({ m, parts, shardOut: null, shardIn: null });
      }
      mine.set(m.name, indices);
    }
    console.log(
      `▶ зерно ${String(seed)}, партий ${String(parts.length)}, замеров ${String(selected.length)},` +
        ` задач ${String(wave.length)}, одновременно ${String(Math.min(jobs, wave.length))}`,
    );
    const counted = await runPool(wave, jobs, (job) => runJob(job, seed, full));

    // Вторая волна — склейка. Карт и симулятора она не грузит, поэтому
    // стоит секунды, но начаться может только после всех своих кусков.
    const toMerge = selected.filter((m) => shardedByParts(m, parts, jobs));
    const mergedList = await runPool(toMerge, jobs, (m) =>
      runJob({ m, parts, shardOut: null, shardIn: shardDir(m) }, seed, full),
    );
    const merged = new Map(toMerge.map((m, i) => [m.name, mergedList[i] as JobRun]));

    // Порядок ключей — как в MEASUREMENTS, а не как замеры финишировали:
    // от него зависит порядок разделов в docs/measurements.md.
    const measurements: Record<string, MeasurementRun> = {};
    for (const m of selected) {
      const pieces = (mine.get(m.name) ?? []).map((i) => counted[i] as JobRun);
      const merge = merged.get(m.name) ?? null;
      const all = merge === null ? pieces : [...pieces, merge];
      // Лог замера — один файл, куски в порядке партий: так он читается
      // ровно как при прогоне подряд.
      writeFileSync(
        join(LOG_DIR, `${stamp}_${sha}_seed${String(seed)}_${m.name.replace(':', '-')}.txt`),
        all.map((r) => r.output).join(''),
      );
      const run: MeasurementRun = {
        // Сумма по задачам, а не время по часам: замеры считаются вперемешку,
        // и «сколько стоил замер» — это его работа, а не окно, в котором
        // она уместилась. С прежними числами такая сумма сравнима.
        durationSec: all.reduce((s, r) => s + r.durationSec, 0),
        exitCode: all.find((r) => r.exitCode !== 0)?.exitCode ?? 0,
        result: merge === null ? (pieces[0]?.result ?? null) : merge.result,
      };
      measurements[m.name] = run;
      console.log(
        `✓ ${m.name}: ${durationLabel(run.durationSec)}, код ${String(run.exitCode)}` +
          `${run.result === null ? ', ИТОГА НЕТ' : ''}`,
      );
    }
    return measurements;
  } finally {
    rmSync(shardRoot, { recursive: true, force: true });
  }
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

  const jobs = jobsArg(argv);
  const wallStarted = Date.now();
  const runs: BatteryRun[] = [];
  for (const seed of seeds) {
    const startedAt = new Date().toISOString();
    const stamp = startedAt.slice(0, 16).replace(/[:T]/g, '-');
    const measurements = await runSeed(selected, parts, seed, full, jobs, stamp, sha);
    const run: BatteryRun = { startedAt, sha, dirty: dirty.length > 0, seed, parts, full, measurements };
    runs.push(run);
    writeFileSync(join(outDir, `${stamp}_${sha}_seed${String(seed)}.json`), `${JSON.stringify(run, null, 2)}\n`);
  }

  // Время ПО ЧАСАМ — не сумма по замерам: задачи шли вперемешку, и ждал
  // пользователь именно этого числа.
  console.log(`\nвсего по часам: ${durationLabel(Math.round((Date.now() - wallStarted) / 1000))}`);

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
