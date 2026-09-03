# Модули и команды

Перенесено из `CLAUDE.md` 02.09.2026. Список модулей выводится и из `ls src/**`,
список команд — из `scripts` в `package.json`; здесь к ним даны пояснения.

### Модули

| модуль | что делает |
|---|---|
| `src/watcher/logPaths.ts` | поиск свежайшей сессии логов Hearthstone |
| `src/watcher/installDir.ts` | где установлена игра: реестр, перебор дисков, явный путь |
| `src/app/paths.ts` | пути данных и записей: из репозитория или из сборки |
| `src/app/config.ts` | настройки приложения: оверлей, папка логов |
| `src/app/elevate.ts` | перезапуск себя через UAC ради client.config |
| `src/app/main.ts` | приложение в трее: сборщик логов всегда, оверлей по галочке |
| `src/collector/archive.ts` | архив Power.log по сессиям клиента: досбор и живая копия |
| `src/collector/export.ts` | архив для отправки одним файлом с манифестом |
| `src/collector/tar.ts` | контейнер ustar своими руками, читается bsdtar |
| `src/collector/cli.ts` | сборщик в терминале, без Electron |
| `src/watcher/clientConfig.ts` | снятие предела размера логов, проверка и починка |
| `src/watcher/tail.ts` | чтение дописываемого файла по байтовому офсету |
| `src/parser/logLine.ts` | строка лога → уровень, время, источник, отступ |
| `src/parser/entity.ts` | дескрипторы и ссылки на сущности |
| `src/parser/blocks.ts` | сборка блоков, поток событий с контекстом |
| `src/state/players.ts` | определение «кто я» |
| `src/state/reducer.ts` | свёртка событий в `GameState` |
| `src/advisors/battle/episodes.ts` | извлечение боёв с известным исходом |
| `src/advisors/battle/mapper.ts` | `GameState` → входной формат симулятора |
| `src/advisors/battle/simulator.ts` | загрузка карт и прогон боя, общие на всех |
| `src/advisors/battle/calibrate.ts` | сверка предсказаний с фактом |
| `src/advisors/battle/spike.ts` | замеры симулятора, воспроизводимые |
| `src/advisors/position/arrangements.ts` | перестановки борда, дедуп по сигнатуре |
| `src/advisors/position/score.ts` | оценки счётчиками, цели сравнения, значимость |
| `src/advisors/position/search.ts` | поиск с накоплением симуляций у выживших |
| `src/advisors/position/opponent.ts` | против кого считать и насколько картинка стара |
| `src/advisors/position/advisor.ts` | публичный вход советника расстановки |
| `src/advisors/position/rng.ts` | детерминированный ГПСЧ, подмена `Math.random` |
| `src/advisors/position/spike.ts` | замеры фазы 3, воспроизводимые |
| `src/advisors/position/spikeField.ts` | замеры цели-поля: молчание, цена K бордов, качество |
| `src/data/cards.ts` | справочник карт: племя, тир, статы по cardId; пул миньонов тира |
| `src/data/bgStats.ts` | статистика мест героев и тринкетов (снапшот Firestone) |
| `src/data/fixtureGames.ts` | партии текущего билда — один список на все скрипты, и одно чтение партии (`readFixtureGame`: `game.log` либо сегменты) |
| `src/data/cardStats.ts` | статистика мест миньонов — только для замера, вне рантайма |
| `src/advisors/tavern/measureCardStats.ts` | дамп «кандидат покупки → исход боя» |
| `src/advisors/tavern/statAnalysis.ts` | арифметика замера: ранжирование, связь, перестановки |
| `src/advisors/tavern/rules.ts` | таблицы правил: тайминги, веса, пороги |
| `src/advisors/tavern/turns.ts` | точки решения — состояния до первой траты |
| `src/advisors/tavern/advisor.ts` | правила подъёма, покупки, продажи, реролла |
| `src/advisors/tavern/spend.ts` | план трат хода: цепочка советов на всё золото |
| `src/advisors/tavern/spendQuality.ts` | сверка плана трат с перебором корзин |
| `src/advisors/tavern/spikeBuff.ts` | замер: атака или здоровье при равной сумме |
| `src/advisors/tavern/spikeLevel.ts` | замер частоты: отставание от кривой и подъём первым |
| `src/advisors/tavern/spikeTaunt.ts` | замер: вредит ли провокация носителю ралли |
| `src/advisors/tavern/spikeHand.ts` | замер: что даёт розыгрыш карты, живущей в руке |
| `src/advisors/tavern/spikeHorizon.ts` | замер: сколько ходов таверны остаётся впереди |
| `src/advisors/tavern/chooserArena.ts` | арена выбирающих: ход игрока против советника, оракула, случайного |
| `src/advisors/tavern/spikeArena.ts` | замер: чей ход лучше по ближайшему бою и каков потолок |
| `src/advisors/tavern/buyQuality.ts` | сверка эвристик покупки с симулятором |
| `src/advisors/tavern/simulated.ts` | досчёт верхних покупок боем в живом режиме |
| `src/live/freshness.ts` | предупреждение «снапшот карт отстал от патча» |
| `src/dataset/recorder.ts` | накопление датасета партий для фазы 6 |
| `src/dataset/backfill.ts` | досбор датасета из фикстур, без повторов по отпечатку |
| `src/dataset/refresh.ts` | что делать с лежащей записью: пересобрать (нет `lobby`), дописать журнал, оставить |
| `src/dataset/import.ts` | приём архива логов исполнителя: нарезка, разбор, дедуп, отчёт |
| `src/ml/dataset.ts` | загрузка датасета: дедуп по отпечатку, фильтр билда |
| `src/ml/features.ts` | признаки точки решения для предсказания места |
| `src/ml/relativeFeatures.ts` | относительные признаки против стола (замер 3): живые, hp и тир против живых, место среди живых |
| `src/ml/historyFeatures.ts` | признаки по истории партии (замер 4): темп потерь, ранг времени жизни, доля побед |
| `src/ml/ridge.ts` | гребневая регрессия закрытой формы, вся «модель» фазы 6 |
| `src/ml/evaluate.ts` | LOGO по партиям, бейзлайны, полоса, вердикт |
| `src/ml/report.ts` | отчёт замера фазы 6 по предрегистрации docs/ml.md |
| `src/ml/imitation.ts` | замер 2: имитация покупок игрока против советника |
| `src/ml/imitationReport.ts` | отчёт замера 2 по предрегистрации docs/ml.md |
| `src/ml/track.ts` | мониторинг датасета между замерами, без вердикта |
| `src/live/lines.ts` | байтовые порции → строки |
| `src/live/feed.ts` | строки → `GameState`, партия за партией |
| `src/live/watcher.ts` | опрос лога, догон, смена сессии клиента |
| `src/live/position/*` | советник расстановки в отдельном потоке |
| `src/live/advisor.ts` | когда звать советников и когда бросать начатое |
| `src/live/session.ts` | склейка слежения и советников, общая на CLI и оверлей |
| `src/watcher/logConfig.ts` | включение записи Power.log, проверка и починка |
| `src/ui/setup.ts` | проверка обеих настроек игры при запуске |
| `src/live/replay.ts` | проигрывание записи через живой путь |
| `src/ui/format.ts` | как советы выглядят словами, общее на CLI и оверлей |
| `src/ui/watch.ts` | живой режим в терминале |
| `src/overlay/view.ts` | что показывать в оверлее, без DOM и Electron |
| `src/overlay/window.ts` | окно поверх игры, включается и выключается из трея |
| `src/ui/demo-phase1.ts` | печать состояния по ходам |
| `src/ui/demo-phase3.ts` | советы по расстановке на боях фикстуры |
| `src/ui/demo-phase4.ts` | советы по таверне на ходах фикстуры |
| `src/ui/capture.ts` | архивация логов поверх лимита клиента |

### Команды

```
npm run watch                       живой режим в терминале
npm run watch -- --replay <лог>     проиграть запись через живой путь
npm run collector                   сборка и приложение в трее: сборщик логов
npm run overlay                     то же с включённым оверлеем поверх игры
npm run collect                     сборщик логов в терминале, без Electron
npm run collect -- --export         собрать архив для отправки и выйти
npm run dist                        инсталлятор для исполнителей → release/
npm run dist:dir                    распакованная сборка → release/win-unpacked/
npm run build                       сборка в dist/
npm run demo:phase1                 состояние по ходам эталонной партии
npm run demo:phase1 -- <путь>       то же на другом логе
npm run demo:phase3                 советы по расстановке на боях фикстуры
npm run demo:phase3 -- <лог> <ход>  один бой
npm run demo:phase4                 советы по таверне на ходах фикстуры
npm run demo:phase4 -- <лог> <ход>  один ход
npm run calibrate                   предсказания против фактических исходов
npm run calibrate -- <лог>          то же на другой партии
npm run update:cards                свежий снапшот карт (сеть по команде)
npm run update:bgstats              свежая статистика мест (сеть по команде)
npm run dataset:backfill            досбор датасета из фикстур текущего билда
npm run dataset:import -- <tar>     приём архива логов исполнителя (--from, --rating; --own — свои)
npm run ml:eval                     замер фазы 6: предсказание места против таблицы
npm run ml:eval3                    замер 3 фазы 6: то же с относительными признаками против стола
npm run ml:eval4                    замер 4 фазы 6: относительные плюс история партии
npm run ml:imitation                замер 2 фазы 6: имитация покупок против советника
npm run ml:track                    мониторинг накопления: что прибавилось и куда движутся числа
npm run validate:tavern             эвристики покупок против симулятора
npm run validate:spend              план трат хода против перебора корзин
npm run spike:battle                перезамер производительности симулятора
npm run spike:position              перезамер всего, на чём стоит фаза 3
npm run spike:field                 перезамер расстановки против поля бордов
npm run spike:buff                  замер «+3/+1 против +1/+3» на фикстурах
npm run spike:level                 подъём: частота совета и согласие с игроком
npm run spike:taunt                 вредит ли провокация носителю ралли
npm run spike:hand                  что даёт розыгрыш карты, живущей в руке
npm run spike:horizon               сколько ходов таверны остаётся впереди
npm run spike:arena                 чей ход лучше по ближайшему бою: игрок, советник, оракул
npm run capture                     архивация растущего Power.log
```
