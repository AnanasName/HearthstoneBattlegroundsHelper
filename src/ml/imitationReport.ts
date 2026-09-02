import { createRng, mean, summarize } from '../advisors/tavern/statAnalysis.js';
import { adviseTavern } from '../advisors/tavern/advisor.js';
import { loadCardIndex } from '../data/cards.js';
import { signFlipBand } from './evaluate.js';
import {
  baseCardOf,
  buildInstances,
  evaluateImitationLogo,
  imitationVerdict,
  IMITATION_FEATURES,
  pickByModel,
  shuffleLabels,
  trainImitation,
  type AdvisorPick,
  type ImitationGameEval,
  type ImitationInstance,
} from './imitation.js';
import { loadDataset } from './dataset.js';
import {
  filterGames,
  formatProvenance,
  parseDatasetFilter,
  provenanceRows,
  type DatasetFilter,
} from './provenance.js';

/**
 * Отчёт замера 2: имитация покупок игрока против советника.
 *
 *   npm run ml:imitation
 *
 * Процедура и критерий предрегистрированы в docs/ml.md («Замер 2») ДО
 * первого прогона; скрипт считает и называет вердикт по записанным
 * условиям. Решает основная ветка (λ=1, LOGO по партиям, D̄ против
 * советника); всё остальное — печать для сведения.
 */

const RIDGE_LAMBDA = 1;
/** Зёрна — предрегистрированы: полоса sign-flip и отрицательный контроль. */
const BAND_SEED = 20260820;
const CONTROL_SEED = 20260821;
const BAND_ITERATIONS = 10_000;
const CONTROL_LEAK_THRESHOLD = 0.05;
/**
 * Реализаций случайных меток в контроле — одна реализация шумит на ±3 п.п.
 * и порог в 5 п.п. был бы меньше двух её сигм; среднее по десяти сжимает
 * шум втрое, порог становится ≈4.5 SE. Все десять — из ОДНОГО сеяного
 * ГПСЧ, последовательность детерминирована.
 */
const CONTROL_REALIZATIONS = 10;
/** Партии, сыгранные ДО первого оверлея (part9): советов игрок не видел. */
const PRE_OVERLAY_RE = /^backfill_part[4-8]_/;

const fmt = (x: number): string => x.toFixed(3);
const pp = (x: number): string => `${(x * 100).toFixed(1)} п.п.`;

const meansOf = (
  evals: readonly ImitationGameEval[],
): { model: number; advisor: number; random: number; stats: number; tier: number } => ({
  model: mean(evals.map((e) => e.hitModel)),
  advisor: mean(evals.map((e) => e.hitAdvisor)),
  random: mean(evals.map((e) => e.hitRandom)),
  stats: mean(evals.map((e) => e.hitStats)),
  tier: mean(evals.map((e) => e.hitTier)),
});

function main(filter: DatasetFilter): void {
  const data = loadDataset();
  const cards = loadCardIndex();

  // Счёт по людям читается ДО чисел, и не для порядка: на своих партиях
  // этот замер меряет «чей выбор ближе к лучшему по бою — игрока или
  // советника», а на чужих тем же счётом выходит УРОВЕНЬ ИСПОЛНИТЕЛЯ.
  // Среднее по нескольким людям — среднее по разным вопросам.
  for (const line of formatProvenance(data.games, filter)) console.log(line);
  const selected = filterGames(data.games, filter);
  if (provenanceRows(selected).length > 1) {
    console.log(
      'ВНИМАНИЕ: в выборке партии РАЗНЫХ людей. Общее среднее этого замера' +
        ' для них не определено — считать надо по каждому отдельно.',
    );
  }

  const build = buildInstances(selected);
  console.log(
    `партий: ${String(selected.length)}, ходов с точкой решения: ${String(build.turnsSeen)}`,
  );
  console.log(
    `инстансов замера: ${String(build.instances.length)} ` +
      `(без покупок из показанного: ${String(build.skippedNoShownBuys)}, ` +
      `куплено всё: ${String(build.skippedAllBought)}, ` +
      `витрина из одного: ${String(build.skippedFewCandidates)})`,
  );
  console.log(
    `исключённые покупки: заклинаний ${String(build.spellBuys)}, ` +
      `вне показанной витрины ${String(build.offShopBuys)}, ` +
      `на ходах без точки решения ${String(build.buysOnMissingTurns)}`,
  );
  for (const g of build.gamesWithoutActions) console.log(`без журнала действий: ${g}`);

  if (build.instances.length < 20) {
    console.log('инстансов меньше двадцати — замер бессмыслен, стоп.');
    return;
  }

  // Выбор советника на инстанс — дорогой, считается один раз на инстанс
  // и переиспользуется всеми ветками (контроль гоняет те же состояния).
  const advisorByInstance = new Map<ImitationInstance, string | null>();
  for (const inst of build.instances) {
    const advice = adviseTavern(inst.state, { cards });
    const top = advice?.recommendations.find((r) => r.action === 'buy' && r.minion !== null);
    advisorByInstance.set(inst, top?.minion == null ? null : baseCardOf(top.minion.cardId));
  }
  const advisorPick: AdvisorPick = (inst) => advisorByInstance.get(inst) ?? null;
  const advisorPicks = build.instances.map((inst) => advisorPick(inst));

  // ГОДНОСТЬ — до главных чисел: отрицательный контроль конвейера.
  // Метки — случайный кандидат; нуль — аналитическое ожидание hit
  // СОБСТВЕННОГО выбора модели (сравнение с random смещено дублями карт).
  // Утечка — только ПОЛОЖИТЕЛЬНЫЙ разрыв: модель хуже собственного шанса —
  // шум в безопасную сторону, прогона он не отменяет.
  const controlRng = createRng(CONTROL_SEED);
  const leaks: number[] = [];
  for (let k = 0; k < CONTROL_REALIZATIONS; k += 1) {
    const shuffled = shuffleLabels(build.instances, controlRng);
    // Выбор советника у контрольных копий тот же — состояние то же.
    const pickByCopy = new Map(shuffled.map((inst, i) => [inst, advisorPicks[i] ?? null]));
    const control = evaluateImitationLogo(
      shuffled,
      cards,
      RIDGE_LAMBDA,
      (inst) => pickByCopy.get(inst) ?? null,
    );
    leaks.push(
      mean(control.evals.map((e) => e.hitModel)) -
        mean(control.evals.map((e) => e.modelChance)),
    );
  }
  const leak = mean(leaks);
  console.log('');
  console.log(
    `годность — отрицательный контроль (${String(CONTROL_REALIZATIONS)} реализаций случайных меток): ` +
      `средний разрыв «модель − шанс её выбора» ${pp(leak)} ` +
      `(мин ${pp(Math.min(...leaks))}, макс ${pp(Math.max(...leaks))})`,
  );
  if (leak > CONTROL_LEAK_THRESHOLD) {
    console.log(
      `ПРОГОН НЕДЕЙСТВИТЕЛЕН: на случайных метках модель лучше шанса своего выбора ` +
        `на ${pp(leak)} > ${pp(CONTROL_LEAK_THRESHOLD)} — в конвейере утечка.`,
    );
    return;
  }

  // ОСНОВНАЯ ветка — предрегистрированная.
  const result = evaluateImitationLogo(build.instances, cards, RIDGE_LAMBDA, advisorPick);
  const evals = result.evals;
  const means = meansOf(evals);
  const deltas = evals.map((e) => e.hitModel - e.hitAdvisor);
  const deltaStats = summarize(deltas);
  const band = signFlipBand(deltas, BAND_ITERATIONS, createRng(BAND_SEED));
  const mde = 1.645 * deltaStats.se;

  console.log('');
  console.log(`— основная ветка: LOGO, λ=${String(RIDGE_LAMBDA)}, ${String(evals.length)} партий —`);
  console.log(`инстансов без выбора советника (исключены): ${String(result.droppedNoAdvisor)}`);
  console.log(
    `hit по партиям: модель ${fmt(means.model)} | советник ${fmt(means.advisor)} | ` +
      `random ${fmt(means.random)} | статы ${fmt(means.stats)} | тир ${fmt(means.tier)}`,
  );
  console.log(
    `D̄ = hit(модель) − hit(советник) = ${pp(deltaStats.mean)} ` +
      `(SE ${pp(deltaStats.se)}, МРЭ ${pp(mde)}, партий с |D|>0.05: ${String(deltaStats.moved)} из ${String(deltaStats.n)})`,
  );
  console.log(
    `полоса sign-flip (${String(BAND_ITERATIONS)} перестановок): 5-й ${pp(band.p05)} … 95-й ${pp(band.p95)}`,
  );
  const verdict = imitationVerdict(deltaStats.mean, band, mde, means.model, means.random);
  console.log(`вердикт по предрегистрированному критерию: ${verdict}`);

  console.log('');
  console.log('— вторичное (не решает) —');

  const topOnly = evaluateImitationLogo(
    build.instances,
    cards,
    RIDGE_LAMBDA,
    advisorPick,
    (inst) => inst.finalPlace <= 3,
  );
  const topDeltas = topOnly.evals.map((e) => e.hitModel - e.hitAdvisor);
  console.log(
    `обучение только на местах 1–3: hit модели ${fmt(mean(topOnly.evals.map((e) => e.hitModel)))}, ` +
      `D̄ ${pp(mean(topDeltas))}`,
  );

  const pre = evals.filter((e) => PRE_OVERLAY_RE.test(e.name));
  const post = evals.filter((e) => !PRE_OVERLAY_RE.test(e.name));
  console.log(
    `до оверлея (part4–8): партий ${String(pre.length)}, ` +
      `D̄ ${pp(mean(pre.map((e) => e.hitModel - e.hitAdvisor)))}; ` +
      `с оверлеем: партий ${String(post.length)}, ` +
      `D̄ ${pp(mean(post.map((e) => e.hitModel - e.hitAdvisor)))}`,
  );

  for (const lambda of [0, 1, 10]) {
    const s = evaluateImitationLogo(build.instances, cards, lambda, advisorPick);
    const d = s.evals.map((e) => e.hitModel - e.hitAdvisor);
    console.log(
      `λ=${String(lambda)}: hit модели ${fmt(mean(s.evals.map((e) => e.hitModel)))}, D̄ ${pp(mean(d))}`,
    );
  }

  const full = trainImitation(build.instances, cards, RIDGE_LAMBDA);
  console.log('');
  console.log('веса модели на всех инстансах (стандартизованные разности):');
  IMITATION_FEATURES.forEach((name, i) => {
    console.log(`  ${name}: ${fmt(full.weights[i] ?? 0)}`);
  });

  // Диагностика, ради которой замер затевался: где модель и советник
  // разошлись и кто оказался прав про игрока. Полная модель — для чтения;
  // числа вердикта выше считаны честной LOGO.
  console.log('');
  console.log('— топ расхождений «модель ↔ советник» (полная модель, диагностика) —');
  const nameOf = (cardId: string | null): string =>
    cardId === null ? '?' : (cards.info(cardId)?.name ?? cardId);
  const disagreements = build.instances
    .map((inst) => {
      const modelPick = pickByModel(full, inst, cards);
      const advisor = advisorPick(inst);
      const model = modelPick === null ? null : baseCardOf(modelPick.cardId);
      return { inst, model, advisor };
    })
    .filter(
      ({ model, advisor }) => model !== null && advisor !== null && model !== advisor,
    )
    .map((d) => ({
      ...d,
      modelRight: d.model !== null && d.inst.boughtCardIds.has(d.model),
      advisorRight: d.advisor !== null && d.inst.boughtCardIds.has(d.advisor),
    }));
  const modelWon = disagreements.filter((d) => d.modelRight && !d.advisorRight);
  const advisorWon = disagreements.filter((d) => !d.modelRight && d.advisorRight);
  console.log(
    `расхождений: ${String(disagreements.length)}; игрок за модель: ${String(modelWon.length)}, ` +
      `за советника: ${String(advisorWon.length)}, мимо обоих: ` +
      `${String(disagreements.length - modelWon.length - advisorWon.length)}`,
  );
  // Обе стороны, не только лестная модели: односторонняя печать читалась бы
  // как отбор доказательств.
  for (const d of modelWon.slice(0, 5)) {
    console.log(
      `  игрок ЗА МОДЕЛЬ — ${d.inst.gameName} ход ${String(d.inst.turn)}: ` +
        `модель → ${nameOf(d.model)}, советник → ${nameOf(d.advisor)}; ` +
        `куплено: ${[...d.inst.boughtCardIds].map(nameOf).join(', ')}`,
    );
  }
  for (const d of advisorWon.slice(0, 5)) {
    console.log(
      `  игрок ЗА СОВЕТНИКА — ${d.inst.gameName} ход ${String(d.inst.turn)}: ` +
        `модель → ${nameOf(d.model)}, советник → ${nameOf(d.advisor)}; ` +
        `куплено: ${[...d.inst.boughtCardIds].map(nameOf).join(', ')}`,
    );
  }
}

main(parseDatasetFilter(process.argv.slice(2)));
