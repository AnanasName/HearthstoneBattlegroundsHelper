# Power.log — что подтверждено фактически

Рабочие заметки по формату. **Правило: сюда попадает только то, что видно в реальном логе,
со ссылкой на источник.** Гипотезы живут в отдельном разделе и не используются в коде,
пока не подтверждены.

Источник для всего ниже, если не указано иное:
`Logs/Hearthstone_2026_08_01_22_30_56/Power.log` — выбор героя + один ход BG,
клиент русский, 2026-08-01, 14 561 строка / 1.3 МБ.

## Окружение

- Установка игры: `C:\Program Files (x86)\Hearthstone` (найдено через
  `HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone` → `InstallLocation`).
- Логи: `<install>/Logs/Hearthstone_YYYY_MM_DD_HH_MM_SS/Power.log`.
  **На каждый запуск клиента создаётся новая папка**, старый файл не дописывается.
  Watcher обязан находить свежайшую сессию и переключаться на новую, если она появилась.
- Включение: `%LOCALAPPDATA%\Blizzard\Hearthstone\log.config`, секция `[Power]`
  с `FilePrinting=true` и `Verbose=true`. Требуется полный перезапуск клиента.
- Логирование реализовано в `Hearthstone_Data/Managed/Blizzard.T5.Logging.dll`.
  Полный список ключей, которые она читает (извлечён из строк сборки):
  `ConsolePrinting`, `ScreenPrinting`, `FilePrinting`, `MinLevel`, `DefaultLevel`,
  `AlwaysPrintErrors`, `TruncatePos`, `Verbose`.
  **`LogLevel` в этом списке нет** — распространённый в чужих конфигах `LogLevel=1`
  просто игнорируется.
- Там же строки `Error deleting previous log session '{0}'` и `*.log` — клиент сам
  удаляет старые сессии. Логи эфемерны, забирать сразу после игры.
- Формат имени папки сессии подтверждён строками из той же сборки:
  `yyyy_MM_dd_HH_mm_ss` и маска `.*\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}`.

## ⚠️ Лимит размера: логирование останавливается целиком

Самое важное ограничение, найдено 02.08.2026.

При достижении файлом предела клиент дописывает в него баннер

```
==================================================================
Truncating log, which has reached the size limit of 10000KB
==================================================================
```

и **файловое логирование прекращается полностью — во всех файлах сразу**, а не только
в том, который упёрся в лимит.

Наблюдение, на котором это установлено (сессия `Hearthstone_2026_08_01_22_30_56`):

| файл | размер | последняя запись |
|------|-------:|------------------|
| `Zone.log` | 10 251 370 | 22:38:49 — упёрся в лимит, баннер в конце |
| `Power.log` | 6 496 962 | 22:38:49 — оборван посреди боевого блока, баннера нет |
| `Hearthstone.log` | 8 839 | 22:38:32 |

`Zone.log` рос быстрее (≈1.7 МБ/мин против ≈1.0 у `Power.log`) и упёрся первым,
утащив за собой всё остальное. Игрок после этого отыграл ещё почти час — в логах пусто.

### Через log.config это НЕ настраивается — но настраивается через client.config

В `log.config` ключа для лимита нет: там разбираются ровно восемь ключей
(`ConsolePrinting`, `ScreenPrinting`, `FilePrinting`, `MinLevel`, `DefaultLevel`,
`AlwaysPrintErrors`, `TruncatePos`, `Verbose`), и `TruncatePos` к размеру файла
отношения не имеет — это обрезка длины отдельного сообщения. Проверено на практике:
`TruncatePos=200000` лимит не изменил.

Однако лимит читается из **другого файла**. Восстановлено по IL (метод найден перебором
строковых токенов, вызовы разрешены через `Module.ResolveMethod`):

```
Log.PopulateLogSessionConfigOptions (Assembly-CSharp.dll):
    new ConfigFile()
    PlatformFilePaths.GetClientConfigPath()      // GetPathForConfigFile("client.config")
    ConfigFile.FullLoad(...)
    ConfigFile.Get("Log.FileSizeLimit.Int", 10000)
    LogSessionConfig.set_MaxFileSizeKilobytes(...)
```

То есть: `%LOCALAPPDATA%\Blizzard\Hearthstone\client.config`, полный ключ
`Log.FileSizeLimit.Int`, дефолт 10000 КБ. `ConfigFile` (`Blizzard.T5.Configuration.dll`) —
тот же INI-парсер, что читает log.config: `FindEntryIndex` сравнивает полный ключ,
склеенный из секции и имени, поэтому файл выглядит так:

```
[Log]
FileSizeLimit.Int=-1
```

Семантика значения — из IL `Blizzard.T5.Logging.dll`:

- `LogSessionConfig..ctor`: `ldc.i4 0x2710` → дефолт 10000 КБ зашит; проверка размера
  каждые 100 записей (`LogWritesBetweenCheckingMaxFileSize`).
- `get_MayLimitMaxFileSize` = `MaxFileSizeKilobytes > -1` → **отрицательное значение
  выключает лимит**.
- `CloseIfMaxFileSizeReached` начинается с `if (!MayLimitMaxFileSize) return` —
  при выключенном лимите до сравнений размера дело не доходит, значит `-1` безопасен.
- Одноразовый флаг `m_maxFileSizeLimitReached`: после срабатывания лимита принтер
  закрыт насовсем, ротации нет. Поэтому опция должна стоять ДО запуска клиента.

client.config игра только читает (в отличие от options.txt, который она перезаписывает
при выходе) — файл можно класть при работающем клиенте, подхватится со следующего запуска.

### Путь: КАТАЛОГ УСТАНОВКИ, а не AppData — подтверждено экспериментом

`GetPathForConfigFile` перебирает несколько кандидатов, и по IL было не видно, какой
выигрывает на Windows. Определено прямым экспериментом: `client.config` разложен
в шесть кандидатных каталогов, в каждом — **свой** лимит (41…46 КБ), и число в баннере
назвало победителя:

```
Truncating log, which has reached the size limit of 44KB
```

44 — метка каталога установки. Рабочий путь:

```
<install>\client.config      ->  C:\Program Files (x86)\Hearthstone\client.config
```

Все три каталога в `AppData` (Local, LocalLow, Roaming) игрой **не читаются**, хотя
`log.config` при этом берётся именно из `%LOCALAPPDATA%\Blizzard\Hearthstone`.
Два файла настройки живут в разных местах — это легко перепутать.

Боевое значение:

```ini
[Log]
FileSizeLimit.Int=1000000
```

Отрицательное значение (`-1`, «без лимита») не проверялось и рискованно:
`GeneralUtils.ForceInt` — самописный `TryParseInt` с фолбэком в 0, а `0 > -1`, то есть
при неудачном разборе лимит станет нулевым и логирование умрёт мгновенно. Большое
положительное значение безопаснее и делает то же самое.

Замечания для продукта:

- Каталог установки на этой машине писуем без прав администратора, но полагаться
  на это нельзя — инсталлятору нужны права.
- Файл лежит рядом с игрой, поэтому **обновление клиента может его снести**.
  Приложение обязано проверять наличие и значение при каждом запуске и чинить.
- Путь установки берётся из реестра:
  `HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Hearthstone`,
  значение `InstallLocation`.
- Изменения подхватываются только при старте клиента: `Log.Initialize` вызывает
  `PopulateLogSessionConfigOptions` один раз.

Статус: ✅ **подтверждено с обеих сторон.**

- Лимит включается: при `FileSizeLimit.Int=44` лог умер на 53 189 байт.
- Лимит снимается: при `FileSizeLimit.Int=1000000` полная партия BG уложилась
  в один файл — **41 394 434 байта, 301 289 строк, 23 минуты, ноль баннеров,
  `FINAL_GAMEOVER` в конце**. Это фикстура `part2`.

Вопрос закрыт: переподключения посреди партии больше не нужны ни для фикстур,
ни для продукта.

Методическая заметка: строка `Log.FileSizeLimit.Int` не находилась обычным поиском,
потому что UTF-16-литералы в сборках лежат и по нечётным смещениям — сканировать надо
в обоих выравниваниях. Первые сканы этим страдали и пропустили в том числе сам текст
баннера.

### Что это значит на практике

Замеренная скорость роста `Power.log` при `Verbose=true` и одной только секции `[Power]`:

| режим | скорость | сколько влезает в 10 МБ |
|---|---|---|
| Battlegrounds | ≈1.7 МБ/мин в среднем за партию | ≈9 минут, примерно до 13-го `TURN` |
| обычный рейтинг | ≈0.35 МБ/мин | 2–3 полные партии |

Скорость в BG растёт по ходу партии — борды больше, событий на ход больше: от ≈1.1 МБ/мин
на первых ходах до ≈3.2 МБ/мин к концу. Полная партия — около 40 МБ за 23 минуты,
то есть **вчетверо больше дефолтного предела**. Отсюда и вся возня ниже.

### Способы обойти, которые НЕ работают

Оба проверены 02.08 на живых партиях. Не тратить на них время повторно.

**`Verbose=false` — не влияет ни на что.** Сравнение двух рейтинговых партий:

| | `Verbose=true` | `Verbose=false` |
|---|---:|---:|
| байт на строку | 113.5 | 113.6 |
| `TAG_CHANGE` с полным дескриптором | 53.3% | 54.7% |
| `FULL_ENTITY` с полным дескриптором | 50.0% | 49.9% |
| `GameState.DebugPrintPower` | 25 897 | 11 203 |
| `PowerTaskList.DebugPrintPower` | 28 258 | 12 019 |

Абсолютные числа различаются только длиной партий. Оба дублирующих канала присутствуют
в обоих случаях, доли одинаковые. Ключ на содержимое `Power.log` не влияет.

**Обрезка файла снаружи — невозможна.** Пока клиент пишет в лог, он держит файл так,
что открытие на запись падает с `EBUSY: resource busy or locked`. Читать при этом можно
(нужен режим с разделяемым доступом). Обрезка удаётся только после того, как клиент сам
закрыл файл по лимиту — но тогда она бесполезна: `m_maxFileSizeLimitReached` уже взведён,
и запись не возобновляется. Проверено: обрезанный в 0 `Power.log` так и остался нулевым.

### Обходной путь, если client.config не подтвердится: реконнект

До подтверждения `Log.FileSizeLimit.Int` единственный проверенный способ получить партию
BG целиком — **перезапустить клиент прямо посреди партии**. Battlegrounds позволяет
переподключиться к идущей игре, при этом создаётся новая папка сессии с собственным
лимитом в 10000 КБ, а клиент делает полный дамп состояния. Полная партия собирается
из нескольких логов; партия 1 в фикстурах собрана именно так, из четырёх частей.

Побочная польза: это единственный способ увидеть, как выглядит дамп при реконнекте.

## Чтение файла

- **Кодировка UTF-8 без BOM.** Первые байты — сразу `44 20 32 32` (`D 22`), сигнатуры нет.
- **Переводы строк смешанные.** Обычные строки завершаются CRLF, а рамка и баннер
  обрезки — одиночными LF. Хвост `segment1.log` побайтово:

  ```
  ...errorParam=<CR><LF><LF><LF>====<LF>Truncating log...<LF>====<LF><CR><LF>
  ```

  Разбиение только по CRLF склеивает весь баннер в одну строку и прячет тот факт,
  что лог оборван. Разбивать надо по `/\r?\n/`.
- ⚠️ Читать строго как UTF-8. При чтении в системной кодировке Windows парсер не падает,
  а тихо портит кириллицу: `PlayerName=Клеопатра` превращается в `РљР»РµРѕРїР°С‚СЂР°`.
- ⚠️ **Файл держит запущенная игра.** Открытие без разделяемого доступа падает с
  «The process cannot access the file … used by another process».
  Нужен режим, разрешающий одновременную запись (FileShare.ReadWrite).

## Строка

```
D 22:32:25.3752664 GameState.DebugPrintPower() -     GameEntity EntityID=7
│ │               │                              │   └─ содержимое, вложенность отступами
│ │               │                              └───── разделитель " - "
│ │               └──────────────────────────────────── канал.метод()
│ └──────────────────────────────────────────────────── время HH:MM:SS.fffffff (7 знаков)
└────────────────────────────────────────────────────── уровень (наблюдался только D)
```

Каналы и их доля в файле:

| строк | канал |
|------:|-------|
| 6564 | `GameState.DebugPrintPower()` |
| 5913 | `PowerTaskList.DebugPrintPower()` |
| 796 | `PowerTaskList.DebugDump()` |
| 380 | `PowerProcessor.PrepareHistoryForCurrentTaskList()` |
| 379 | `PowerProcessor.EndCurrentTaskList()` |
| 325 | `GameState.DebugPrintOptions()` |
| 140 | `GameState.DebugPrintPowerList()` |
| 31 | `PowerProcessor.DoTaskListForCard()` |
| 11 | `GameState.DebugPrintEntityChoices()` |
| 6 | `GameState.DebugPrintGame()` |
| 5 | `GameState.SendOption()` |
| 4 | `GameState.DebugPrintEntitiesChosen()` |
| 4 | `GameState.SendChoices()` |
| 2 | `ChoiceCardMgr.WaitThenShowChoices()` |
| 1 | `ChoiceCardMgr.WaitThenHideChoicesFromPacket()` |

### Выбор канала-источника — решено

`GameState.DebugPrintPower` и `PowerTaskList.DebugPrintPower` дублируют друг друга.
На эталонной партии их счётчики совпадают в точности:

| конструкция | GameState | PowerTaskList |
|---|---:|---:|
| `TAG_CHANGE` | 57 391 | 57 391 |
| `BLOCK_START` | 3 469 | 3 469 |
| `BLOCK_END` | 3 431 | 3 431 |
| `FULL_ENTITY` | 2 425 | 2 425 |
| `SHOW_ENTITY` | 1 349 | 1 349 |
| `META_DATA` | 821 | 1 019 |

Применять оба нельзя — теги применились бы дважды. **Источник истины —
`GameState.DebugPrintPower`**, по двум измеренным причинам.

**Приходит раньше.** Из 27 031 сопоставимых событий GameState был первым в 20 677
случаях против 131 у PowerTaskList. Для советника в реальном времени это прямая
экономия задержки.

**Именует сущности числовыми id.** Расхождение между каналами — не в наборе событий,
а в форме ссылки:

```
GameState:      TAG_CHANGE Entity=11            tag=PLAYSTATE value=PLAYING
PowerTaskList:  TAG_CHANGE Entity=AngryMem#2886 tag=PLAYSTATE value=PLAYING
```

Числовой id однозначен и не зависит от языка клиента. Имена из PowerTaskList
человекочитаемы, но их и так можно получить из `GameState.DebugPrintGame`.

## Блоки и вложенность

Виды блоков за эталонную партию: `TRIGGER` 5462, `POWER` 656, `PLAY` 442,
`ATTACK` 172, `DEATHS` 146, `MOVE_MINION` 60.

⚠️ **`BLOCK_END` есть не у каждого `BLOCK_START`.** 3469 открытий против 3431 закрытий —
38 блоков остаются незакрытыми, причём одинаково в обоих каналах, то есть это свойство
лога, а не сбой записи. Стек, ждущий `BLOCK_END`, копил бы глубину до конца партии.

Структуру честно несёт **отступ**: `BLOCK_END` всегда идёт с тем же отступом, что и
открывший его `BLOCK_START`, а содержимое блока — на 4 глубже.

```
отступ 0:  BLOCK_START BlockType=PLAY …          <- покупка улучшения таверны
отступ 4:      TAG_CHANGE … RESOURCES_USED=4
отступ 4:      BLOCK_START BlockType=TRIGGER …
отступ 8:          TAG_CHANGE … tag=4212 value=7
отступ 4:      BLOCK_END                          <- закрывает TRIGGER, не PLAY
отступ 4:      BLOCK_START BlockType=POWER …
отступ 8:          TAG_CHANGE … PLAYER_TECH_LEVEL=2
```

Поэтому блок надо закрывать, как только встречена строка с отступом не больше его
собственного, а `BLOCK_END` считать полезной, но не обязательной меткой.

Отступы **не всегда кратны 4**: встречаются 22, 26, 30, 34. Это подпункты `META_DATA`
вида `Source = [...]` и `Targets[0] = [...]` со своей разметкой. Вычислять глубину
как `отступ / 4` нельзя — только сравнивать отступы между собой.

## Конструкции внутри блоков

Наблюдались: `TAG_CHANGE` (5906), `BLOCK_START`/`BLOCK_END` (по 456), `FULL_ENTITY` (294),
`SHOW_ENTITY` (78), `HIDE_ENTITY` (62), `META_DATA` (84), `SUB_SPELL_START`/`SUB_SPELL_END` (по 26).

Источник — **не всегда** `Класс.Метод`. В фикстурах 24 раза за партию встречается

```
D 00:25:07.8784271 PowerSpellController [taskListId=2162].InitPowerSpell() - FAILED to attach…
```

то есть с пробелом и скобками внутри. Брать источник надо нежадно до первого `() -`,
а не по списку допустимых символов.

Дескриптор сущности:

```
[entityName=Выживший красный дракон id=408 zone=PLAY zonePos=1 cardId=BG35_814 player=11]
```

Поля всегда идут в одном порядке — `entityName id zone zonePos cardId player`, 120 641 раз
за эталонную партию. Ловушки, все проверены на партии 2:

- `entityName` **локализован** — опираться нельзя, только `cardId`.
- ⚠️ **`entityName` может содержать вложенные квадратные скобки.** Форма
  `[entityName=UNKNOWN ENTITY [cardType=INVALID] id=255 zone=SETASIDE zonePos=0 cardId= player=4]`
  встречается **11 525 раз, около 10% всех дескрипторов**. Разбор «до первой `]`»
  обрежет её на `[cardType=INVALID]` и молча потеряет id, zone, cardId и player.
  Разбирать надо позиционно по именам полей, не полагаясь на закрывающую скобку.
- `entityName` бывает пустым (1 725 раз).
- `cardId` бывает пустым — скрытая карта, 11 113 раз.
- `entityName` содержит пробелы («Воришка Бигглсуорт», «Бармен Боб»), поэтому
  наивное разбиение по пробелам тоже не годится.

После `Entity=` стоит не только дескриптор. Три вида ссылок, счёт за эталонную партию:

| вид | сколько | пример |
|---|---:|---|
| дескриптор | 84 686 | `Entity=[entityName=… id=408 …]` |
| голый id | 17 831 | `Entity=1` |
| имя | 11 000+ | `Entity=GameEntity`, `Entity=AngryMem#2886`, `Entity=Бармен` |

Имена — это `GameEntity` и участники лобби по BattleTag либо нику. Ссылка по BattleTag —
самый надёжный способ узнать, что событие относится к самому игроку.

Зоны, встреченные в `tag=ZONE value=`: `PLAY`, `HAND`, `SETASIDE`, `GRAVEYARD`, `REMOVEDFROMGAME`.
**Отдельной зоны под магазин таверны нет.**

## Игроки: кто я

Партия BG моделируется как игра **двух** сущностей `Player`, хотя игроков восемь.
Объявляются они в `CREATE_GAME`:

```
Player EntityID=11 PlayerID=4  GameAccountId=[hi=144115198130930503 lo=113002704]
    tag=CONTROLLER value=4
    tag=PLAYER_ID value=4
    tag=HERO_ENTITY value=31
Player EntityID=12 PlayerID=12 GameAccountId=[hi=0 lo=0]
    tag=HERO_ENTITY value=62          <- Бармен Боб
```

**Свой игрок опознаётся по ненулевому `GameAccountId`** — у системного слота он
`[hi=0 lo=0]`. Это признак из самого лога, не завязанный на номера.

Второй слот — **переиспользуемый «соперник»**. В таверне в нём сидит Боб, на бой
подставляется герой очередного оппонента: `HERO_ENTITY` этого слота ходит между 62
и id героя противника, а имя сущности меняется на ник оппонента:

```
TAG_CHANGE Entity=Petushochek tag=HERO_ENTITY value=590
TAG_CHANGE Entity=Petushochek tag=HERO_ENTITY value=62
```

**Свой герой берётся из `HERO_ENTITY` своего игрока**, и он меняется при выборе героя:

```
TAG_CHANGE Entity=AngryMem#2886 tag=HERO_ENTITY value=94
```

На эталонной партии это дало id=94 — ровно того героя, которого подтвердил человек.
Способ надёжнее поиска по `cardId`, который на концовке перестаёт быть уникальным.

Герои всех восьми участников лобби видны как сущности `CARDTYPE=HERO` с тегом
`PLAYER_ID`, под контроллером системного слота.

Имена берутся из отдельного канала:

```
GameState.DebugPrintGame() - PlayerID=4, PlayerName=AngryMem#2886
GameState.DebugPrintGame() - PlayerID=12, PlayerName=SilentStorm
```

## Фаза партии

Тег `BOARD_VISUAL_STATE` на `GameEntity`: **1 — таверна, 2 — бой**.

Подтверждено на эталонной партии: все 86 блоков `BlockType=ATTACK` пришлись на
значение 2, ни одного на 1. Хронология тоже чистая:

```
TURN=2 → VISUAL=2 → ATTACK… → VISUAL=1 → TURN=3
TURN=4 → VISUAL=2 → ATTACK… → VISUAL=1 → TURN=5
```

## Энчанты

Энчант — отдельная сущность с `CARDTYPE=ENCHANTMENT` и тегом **`ATTACHED`**,
который указывает на носителя:

```
FULL_ENTITY - Creating ID=12204 CardID=BG_ShopBuff_Elemental_Ench
    tag=CARDTYPE value=ENCHANTMENT
    tag=ATTACHED value=12199        <- id миньона
    tag=CREATOR_DBID value=116735
```

За эталонную партию их 1084, из них 975 висят на миньонах. Самые частые —
`BG_ShopBuff_Ench` (215), `BG_ShopBuff_Elemental_Ench` (168),
`TB_BaconShopBadsongE` (100), `BG20_GEMe` (кровавые самоцветы, 42).
На одном миньоне к концу партии набирается больше десятка.

Полезные теги на энчанте: `TAG_SCRIPT_DATA_NUM_1` и `TAG_SCRIPT_DATA_NUM_2` —
это ровно то, что симулятор ждёт в `tagScriptDataNum1/2`.

Поля `timing`, которое симулятор требует, в логе нет. Но оно нужно только для
упорядочивания, и сам симулятор при пустом значении подставляет производную
от идентификатора:

```js
// enchantments.js
timing: enchantment.timing || entity.entityId + index + 1,
```

Идентификаторы растут монотонно по времени создания, поэтому `entityId`
энчанта — корректный источник `timing`.

Снятые энчанты уходят в `GRAVEYARD`, `REMOVEDFROMGAME` или `SETASIDE`
и в состояние попадать не должны.

## Следующий противник известен заранее

Тег **`NEXT_OPPONENT_PLAYER_ID`** приходит на сущность игрока в таверне и точно
называет того, с кем предстоит драться:

```
ход  1 tavern  NEXT_OPPONENT_PLAYER_ID=5
ход  2 combat  Entity=Petushochek HERO_ENTITY=590     <- дерёмся с ним
ход  2 tavern  Entity=Petushochek HERO_ENTITY=62      <- вернулся Боб
ход  2 tavern  NEXT_OPPONENT_PLAYER_ID=3
ход  4 combat  Entity=Umits HERO_ENTITY=955
```

Объявление относится к **следующему** бою, а не к текущему ходу.
Проверено на обеих полных партиях: **18 совпадений из 18** сопоставимых.
Несопоставимы только первые бои, где объявления ещё не было.

Кто скрыт за чужим слотом, определяется **через героя**: у героя каждого
участника лобби есть тег `PLAYER_ID`. По подписи слота ориентироваться нельзя —
в поздних боях она остаётся «Бармен Боб», хотя дерёмся с игроком.

⚠️ Тег `BACON_CURRENT_COMBAT_PLAYER_ID` для этого **не годится**: в обеих
фикстурах он равен идентификатору самого игрока (4 и 3), а не противника.

Практическое следствие: в таверне известно, против кого считать расстановку.
Если с этим игроком уже дрались, его борд есть в `lastSeenBoards`.

## Борд противника снимать надо в НАЧАЛЕ боя

Видно его только во время боя, но к выходу в таверну чужие миньоны уже убраны
из `PLAY`, а к концу боя половина мертва. Момент ловится по первому блоку
`ATTACK`: обе стороны расставлены, размены ещё не начались.

## Счётчики игрока для симулятора

Именованные теги на сущности игрока, которые ложатся в `globalInfo` симулятора:

| тег лога | поле симулятора |
|---|---|
| `NUM_RESOURCES_SPENT_THIS_GAME` | `GoldSpentThisGame` |
| `NUM_SPELLS_PLAYED_THIS_GAME` | `SpellsCastThisGame` |
| `NUM_CARDS_PLAYED_THIS_TURN` | `CardsPlayedThisTurn` |
| `TAVERN_SPELL_ATTACK_INCREASE` | `TavernSpellAttackBuff` |
| `TAVERN_SPELL_HEALTH_INCREASE` | `TavernSpellHealthBuff` |
| `BACON_ELEMENTAL_BUFFATKVALUE` | `ElementalAttackBuff` |
| `BACON_ELEMENTAL_BUFFHEALTHVALUE` | `ElementalHealthBuff` |

Остальные счётчики симулятора в логе приходят **безымянными числовыми тегами** —
на сущности игрока их 62 штуки за партию. Сопоставить их с полями без
дополнительных данных нельзя, поэтому не гадали. Набор именованных тегов
зависит от механик партии: например, счётчики кровавых самоцветов появятся
только в партии с кабанами.

Полезное сверх симулятора: `BACON_WON_LAST_COMBAT`, `DAMAGE_DEALT_TO_HERO_LAST_TURN`,
`BACON_PLAYER_EXTRA_GOLD_NEXT_TURN`.

## Пять ловушек при сборке состояния

Все найдены тестами и демо на эталонной партии; каждая давала не падение,
а тихо неверный результат.

**1. Дескриптор в `TAG_CHANGE` показывает состояние ДО изменения и бывает устаревшим.**
Если брать из него `zone`, мёртвые миньоны воскресают. История зон одного миньона
при таком разборе выглядела так:

```
SETASIDE > PLAY > GRAVEYARD > PLAY > REMOVEDFROMGAME > PLAY
```

Каждый возврат в `PLAY` приходил из дескриптора уже после удаления. Зону и позицию
надо брать **только из явных тегов** `ZONE` и `ZONE_POSITION`, а дескриптор считать
контекстом для чтения.

**2. Фильтровать сущности нужно белым списком, а не чёрным.** У части сущностей
`CARDTYPE` в логе не встречается вовсе, и при отборе «всё кроме энчантов и героев»
на борду оказалось 455 миньонов вместо максимум семи. Правильно — брать только явные
`CARDTYPE=MINION`.

**3. `HIDE_ENTITY` несёт смену зоны, но начинается не с `TAG_CHANGE`.**

```
HIDE_ENTITY - Entity=[…] tag=ZONE value=REMOVEDFROMGAME
```

Таких строк 1221 за партию. Разбор, который ищет только `TAG_CHANGE`, пропускает их
целиком, и убранные сущности навсегда остаются в `PLAY`. Тег в конце строки надо
применять так же, как из `TAG_CHANGE`.

**4. `SHOW_ENTITY` называет сущность через `Entity=`, а `FULL_ENTITY` — через `ID=`.**

```
FULL_ENTITY - Creating ID=63  CardID=TB_BaconShop_8P_PlayerE
SHOW_ENTITY - Updating Entity=255 CardID=TB_BaconShop_HP_038e
```

Разбор, знающий только форму `FULL_ENTITY`, теряет все 1349 событий раскрытия
за партию: 1262 из них идут с голым id, и **все несут непустой `CardID`**.
Последствие тихое и дорогое — раскрытые карты остаются без `cardId`. На этом
из 1084 энчантов партии в состояние доходил 21.

`SHOW_ENTITY` авторитетнее прежних сведений: это раскрытие ранее скрытой карты,
и `cardId` из него надо перезаписывать, а не только дополнять пустой.

**5. Одинаковые имена тегов приходят на разные сущности с разным смыслом.**
`TURN` на `GameEntity` — номер хода партии, он дорастает до 24. `TURN` на самой
сущности игрока — его собственный счётчик, вдвое меньше. Без привязки к субъекту
побеждало значение, пришедшее последним, и номер хода занижался вдвое. То же
касается `PLAYER_TECH_LEVEL`, `RESOURCES` и `RESOURCES_USED` — их надо принимать
только от своего игрока.

Во второй строке `Zone.log` лежит полный состав лобби — восемь участников:

```
players[0]=[ID=3 …] players[1]=[ID=11 …]
playerInfos[0]=[ID=8 …] playerInfos[1]=[ID=7 …] … playerInfos[7]=[ID=1 …]
```

Нумерация в `players[]` и `playerInfos[]` разная, соответствие не установлено.
`Zone.log` сейчас отключён ради лимита размера; образцы обеих сессий сохранены
в `data/logs-raw/`, если понадобится вернуться к этому вопросу.

## BG-специфичные теги

Именованные теги, встреченные в этом логе:

- Тир: `PLAYER_TECH_LEVEL`, `BACON_MAX_PLAYER_TECH_LEVEL`, `TECH_LEVEL` (тир миньона)
- Золото: `RESOURCES`
- Тройки: `BACON_TRIPLE_UPGRADE_MINION_ID`
- Тринкеты: `BACON_TRINKETS_ACTIVE`, `BACON_TURNS_LEFT_TO_DISCOVER_TRINKET`,
  `BACON_IS_POTENTIAL_TRINKET`, `BACON_IS_MAGIC_ITEM_DISCOVER`
- Племена в пуле: `BACON_SUBSET_DEMON`, `BACON_SUBSET_BEAST`, `BACON_SUBSET_ELEMENTALS`, `BACON_SUBSET_DRAGON`
- Прочее: `IS_BACON_POOL_MINION`, `BACON_ACTION_CARD`, `BACON_HEROPOWER_BASE_HERO_ID`,
  `BACON_COMPANION_ID`, `BACON_HERO_CAN_BE_DRAFTED`, `NUM_TURNS_IN_PLAY`, `NUM_TURNS_IN_HAND`

**Скидка на покупку миньона** — теги на самом миньоне витрины:
`BACON_REDUCE_BUY_COST` (сколько золота скинуто) в паре
с `BACON_SHOW_OVERRIDEN_MINION_COST=1` (клиенту — рисовать новую цену).
Фактура: part3, 12:42 — `9999` на ранних витринах, миньоны бесплатны
(кламп в ноль); part4, 00:25 — `2` на двух миньонах из витрины, цена 1,
остальные по три. По окончании эффекта оба тега сбрасываются в 0.
Цена покупки без скидки на МИНЬОНЕ в логе не встречается вовсе — это
правило игры (3).

**Живая цена покупки лежит на КНОПКЕ, и это единственный источник, который
не пропускает** (part35, 28.08). У каждого миньона витрины своя кнопка
`TB_BaconShop_DragBuy` (`CARDTYPE=MOVE_MINION_HOVER_TARGET`, `CREATOR=69`);
связь — тег, который игра не именует, в логе он числом:
`TAG_CHANGE Entity=7345 tag=2442 value=7344` (значение — id миньона), и парный
`TAG_CHANGE Entity=7344 tag=HAS_DRAG_TO_BUY value=1` на миньоне; цена — тег
`COST` кнопки (`TAG_CHANGE Entity=7345 tag=COST value=3`). При обновлении
витрины отработавшие кнопки уходят в `REMOVEDFROMGAME` и связка сбрасывается
в 0 (`tag=2442 value=0`), новые создаются в том же блоке. Тег `2442` есть
во всех фикстурах (part2 — 764 строки, part4 — 292, part34 — 1812).

Два источника цены сходятся там, где есть оба: part4, 00:25:09 — кнопка 5929
получает `COST value=1` строкой РАНЬШЕ, чем миньон 5928 — `BACON_REDUCE_BUY_COST
value=2` (сверка по всем снимкам таверны part4: 6824 согласий, 2 расхождения —
оба на этом одном событии). Но бывает и ТОЛЬКО кнопка: «Мозаика Стылой Межи»
`BG35_MagicItem_755t` («Refresh the Tavern with Battlecry minions. They cost
(1).», part35, 18:05:10) в блоке `PLAY` пересоздаёт витрину (пять миньонов
с `BATTLECRY` новыми сущностями и заклинание `BG28_603` с `COST=1`), каждой
новой кнопке пишет `COST value=3` при создании и `COST value=1` в конце блока
— а тега `BACON_REDUCE_BUY_COST` в этой партии нет ни на одной сущности
(0 строк на 23 МБ). Редьюсер читает цену с кнопки (`Minion.buyCost`), тег
скидки — запасной путь.

**Состав племён партии прямым тегом не приходит.** `CARDRACE` строками
(`UNDEAD`, `MECHANICAL`) стоит на сущностях, но показывает ОДНО племя даже
у двуплеменной карты и потому создаёт фантомы: в part11 (партия без мехов
и драконов) `MECHANICAL` приходит от «Руки-протеза» (MECH/UNDEAD, в пуле
из-за нежити), `DRAGON` — от Firescale Hoarder (DRAGON/NAGA, в пуле из-за
наг). Работает другое: копить cardId миньонов, виденных в витрине
(она предлагает только пул), и брать племена из снапшота — однoплеменный
миньон витрины доказывает своё племя, двуплеменные и амальгамы — нет.
На part11 метод даёт ровно пять племён партии.

На `GameEntity` в `CREATE_GAME`: `GAME_SEED`, `BACON_GLOBAL_ANOMALY_DBID=119094`,
`BACON_BARTENDER_CARD_ID=57110`, `BACON_TRINKETS_ACTIVE=1`, `BACON_DUOS_PUNISH_LEAVERS=1`,
`BACON_MULLIGAN_HERO_REROLL_ACTIVE=1`.

Аномалия партии есть в логе **двумя способами**, и маппинг dbId→cardId для неё
не нужен — вопреки моему первому выводу. Подтверждено на партии 2, где игрок назвал
аномалию по памяти, и она сошлась с логом:

```
tag=BACON_GLOBAL_ANOMALY_DBID value=102075                   <- на GameEntity, dbId
FULL_ENTITY - Creating ID=362 CardID=BG27_Anomaly_301        <- отдельная сущность
    tag=CARDTYPE value=BATTLEGROUND_ANOMALY
[entityName=Ложные идолы id=362 … cardId=BG27_Anomaly_301]   <- False Idols
```

Достаточно найти сущность с `CARDTYPE=BATTLEGROUND_ANOMALY` и взять её `cardId`.
`BACON_GLOBAL_ANOMALY_DBID` годится как ранний признак: он приходит в `CREATE_GAME`,
то есть до появления самой сущности.

Часть тегов приходит без имени, голым числом: `tag=937 value=3459`, `tag=1488 value=1`,
`tag=4730 value=5`. Парсер обязан переживать неизвестные числовые теги, а не падать на них.

## Известные cardId

- Слоты тринкетов: `BG30_Trinket_1st`, `BG30_Trinket_2nd`
- Призрак: `TB_BaconShop_HERO_KelThuzad` — лежит в `SETASIDE` заранее, ещё до боёв
- Кнопка реролла: `TB_BaconShop_8p_Reroll_Button`
- Кнопка заморозки: `TB_BaconShopLockAll_Button`
- Сила героя (пример): `TB_BaconShop_HP_103`
- Миньон (пример): `BG35_814`

## Модальные выборы: DebugPrintEntityChoices и SendChoices

Все выборы «возьмите одно из» идут отдельным каналом, не через зоны.
Подтверждено на part9 — 10 выборов `ChoiceType=GENERAL` за партию: лавка
аксессуаров (источник `BG30_Trinket_1st`/`BG30_Trinket_2nd`), награда
за тройку (`TB_BaconShop_Triples_01`), раскопки карт (`BG34_330`,
`BG31_890` и другие).

Открытие — `GameState.DebugPrintEntityChoices()`:

```
D 22:38:41 GameState.DebugPrintEntityChoices() - id=3 Player=AngryMem#2886 TaskList= ChoiceType=GENERAL CountMin=1 CountMax=1
D 22:38:41 GameState.DebugPrintEntityChoices() -   Source=[entityName=Межвременной поиск id=4218 zone=PLAY zonePos=0 cardId=BG34_330 player=4]
D 22:38:41 GameState.DebugPrintEntityChoices() -   Entities[0]=[entityName=Зачарованный часовой id=4431 zone=SETASIDE zonePos=0 cardId=BG35_341 player=4]
```

Закрытие — `GameState.SendChoices()` с тем же id и выбором игрока:

```
D 22:38:52 GameState.SendChoices() - id=3 ChoiceType=GENERAL
D 22:38:52 GameState.SendChoices() -   m_chosenEntities[0]=[entityName=Зачарованный часовой id=4431 … cardId=BG35_341 player=4]
```

Что важно и легко сделать неправильно:

- **`cardId` вариантов стоит прямо в дескрипторах строк** — зонные сущности
  не нужны. Больше того, id в `Entities[i]` НЕ совпадают с id сущностей,
  созданных для тех же карт через `FULL_ENTITY` в `SETASIDE` (в примере
  выше выбор называет 4431–4433, а `FULL_ENTITY` создавал 4428–4430):
  клиент держит два комплекта, и связывать их по id нельзя.
- **`TaskList=` бывает пуст** — у раскопок part9 значения нет.
- **Выбор героя приходит тем же каналом** с `ChoiceType=MULLIGAN` —
  его надо отличать.
- **`PowerTaskList` этот канал не дублирует** — применять можно без
  дедупликации.
- **Строки каналов выбора нельзя пропускать через стек блоков**: их отступ
  (2 у `Source=`/`Entities[i]=`) не имеет отношения к вложенности
  `DebugPrintPower` и закрывал бы открытые блоки посреди содержимого.
- Предложение тринкетов ПАРАЛЛЕЛЬНО видно и по зонам (`BACON_TRINKET=1`
  в `SETASIDE`, см. выше) — но зонный путь опаздывает: в точке решения
  хода 11 part9 зонами видны 3 варианта из 4, а канал выбора называет
  все четыре сразу.


## «Choose One» у МИНЬОНА: SETASIDE, PARENT_CARD и SubOption (part28)

Модальный миньон — `Snare Trapper` `BG36_332`, «Choose One — Get a random
Quilboar; or Increase your maximum Gold by {0}» — **каналом выборов
не приходит вовсе**. Его ветви живут отдельными сущностями:

```
D 23:19:38 GameState.DebugPrintPower() -         FULL_ENTITY - Creating ID=4690 CardID=BG36_332t
D 23:19:38 GameState.DebugPrintPower() -         FULL_ENTITY - Creating ID=4691 CardID=BG36_332t2
D 21:16:17 PowerTaskList.DebugPrintPower() -     TAG_CHANGE Entity=[entityName=Обездвижить цель id=6218 zone=SETASIDE zonePos=0 cardId=BG36_332t player=2] tag=PARENT_CARD value=6217
```

Что из этого следует и что легко прочитать неверно:

- **Ветви создаются при появлении карты в витрине, а не при розыгрыше.**
  В part28 они созданы в 23:19:38, а разыграл карту игрок в 23:20:31 —
  то есть зона `SETASIDE` признаком «экран выбора открыт» НЕ является,
  и поймать открытый выбор нечем. `DebugPrintEntityChoices` для такого
  выбора не пишется, `openChoice` остаётся пуст.
- **Что выбрал игрок, говорит `SubOption` в блоке `PLAY`**: `SubOption=0` —
  первая ветвь, `SubOption=1` — вторая; у действий без выбора там `-1`.

  ```
  D 23:20:31 GameState.DebugPrintPower() - BLOCK_START BlockType=PLAY Entity=[entityName=Мастер ловушек id=4700 zone=HAND zonePos=3 cardId=BG36_332 player=6] … SubOption=0
  ```

  Следом ветвь и отрабатывает: `FULL_ENTITY - Creating ID=4847
  CardID=BG20_101` (Roadboar, тир 2 при таверне 4 — то есть «random
  Quilboar» берётся из пула тиров 1..N) плюс энчант `TB_BaconShopBadsongE`,
  то есть карта приходит в руку и играется бесплатно.
- **Плейсхолдер ветви лежит на сущности ветви и на родителе**:
  `TAG_SCRIPT_DATA_NUM_1 value=1` у `BG36_332` и у `BG36_332t2` — «+1
  к максимуму золота».

## Предел золота бывает БОЛЬШЕ десяти

Тег `RESOURCES` — это максимум золота хода, и правилом игры он растёт
до 10. Карты его поднимают выше, и это видно логом: в part27 значения
доходят до **19** (14 строк со значением 11, дальше 12, 13, …, 19),
в part28 у соперника — 11. Значит эффект «Increase your maximum Gold
by N» — не «плюс монета в этот ход» и не «быстрее упрёшься в потолок»,
а по монете каждый оставшийся ход до конца партии.

## Сила героя с ЦЕЛЬЮ в витрине: Target у блока PLAY (part29)

Силы героя применяются блоком `BlockType=PLAY` на своей сущности — это
записано выше. У **целевой** силы у того же блока заполнено поле `Target=`,
и целью бывает миньон ВИТРИНЫ (`player=11`). Фактура — «Lock and Load»
Тавиша `BG22_HERO_000p_Alt` («Remove a minion in the Tavern. When you have
space next combat, fire it at a random enemy minion»), 13 нажатий за партию:

```
01:09:37 BLOCK_START BlockType=PLAY Entity=[… id=181 cardId=BG22_HERO_000p_Alt player=3]
         Target=[entityName=Подозрительный надзиратель id=451 … cardId=BG36_345 player=11] SubOption=-1
    TAG_CHANGE Entity=[… id=181 …] tag=CARD_TARGET value=451
    BLOCK_START BlockType=POWER …
        FULL_ENTITY - Creating ID=491 CardID=BG36_345      ← копия цели
            tag=CONTROLLER value=3      tag=ZONE value=SETASIDE
            tag=ATK value=3             tag=HEALTH value=3
        TAG_CHANGE Entity=491 tag=COPIED_FROM_ENTITY_ID value=451
        TAG_CHANGE Entity=[… id=181 …] tag=TAG_SCRIPT_DATA_ENT_1 value=491
        TAG_CHANGE Entity=[… id=181 …] tag=TAG_SCRIPT_DATA_NUM_1 value=1   ← заряд
        HIDE_ENTITY - Entity=[… id=451 …] tag=ZONE value=SETASIDE
        SHOW_ENTITY - Updating Entity=[… id=451 …] …
            tag=ZONE value=REMOVEDFROMGAME                 ← из витрины насовсем
```

Что отсюда читается:

- **цель — поле `Target=` блока PLAY**, тем же способом, каким читаются
  цели заклинаний;
- **заряд — `TAG_SCRIPT_DATA_NUM_1` на сущности силы**, а сама заряженная
  копия — `TAG_SCRIPT_DATA_ENT_1`. В начале следующего боя заряд тратится
  обратно в ноль (`NUM_1` 1 → 0), и копия выходит на пустой слот: на
  01:10:40 выстреленный Клыкастый походник 2/4 получает 4 урона от чужого
  Иглошкура и уходит в `SETASIDE`. Пар «1 → 0» за партию тринадцать —
  по одной на ход;
- **карта витрины уходит `REMOVEDFROMGAME`**, то есть нажатие силы стоит
  одной карты магазина. Витрину это не дозаполняет.

Слов «remove a minion» среди 2147 карт типа `HERO_POWER` в снапшоте
не встречается больше нигде: сила такая в пуле одна.

## Цена в ЗДОРОВЬЕ: BACON_COSTS_HEALTH_TO_BUY и META_DATA SPEND_HEALTH

Цена карты витрины лежит в теге `COST` — но платится она не всегда
золотом. Признак — **тег `BACON_COSTS_HEALTH_TO_BUY=1` на самой карте**,
он приходит вместе с остальными в `FULL_ENTITY`:

```
01:11:43 FULL_ENTITY - Creating ID=1709 CardID=BG28_571
             tag=CARDTYPE value=BATTLEGROUND_SPELL
             tag=COST value=3
             tag=BACON_COSTS_HEALTH_TO_BUY value=1
```

Покупка выглядит так (Hasty Excavation `BG28_571`, «Gain 1 Gold. This costs
Health to buy instead of Gold»):

```
01:14:09 BLOCK_START BlockType=PLAY … cardId=TB_BaconShop_DragBuy_Spell
         Target=[entityName=Торопливые раскопки id=2364 … cardId=BG28_571 player=11]
    TAG_CHANGE … Главный разведчик Тавиш … tag=PREDAMAGE value=3
    META_DATA - Meta=SPEND_HEALTH Data=0
    BLOCK_START BlockType=TRIGGER Entity=[… id=2355 cardId=BG26_174 …]   ← Soul Rewinder
    META_DATA - Meta=DAMAGE Data=3
    TAG_CHANGE … Тавиш … tag=ARMOR value=11         ← было 14
    META_DATA - Meta=SPEND_HEALTH Data=3
    BLOCK_START BlockType=TRIGGER Entity=[… cardId=BG26_174 …]
        TAG_CHANGE … Тавиш … tag=ARMOR value=14     ← вернулось
        TAG_CHANGE … BG26_174 … tag=HEALTH value=2  ← «and give this +1 Health»
```

То есть трата здоровья — это настоящий урон герою (`PREDAMAGE` → `DAMAGE`
→ `ARMOR`), и триггер «After your hero takes damage, rewind it» на неё
срабатывает. Обратный ход подтверждён числом: броня 14 → 11 → 14.

Тег ставит игра, и ставит его не только на карты, у которых цена
в здоровье своя. В пуле есть источники, делающие платой за здоровье ЧУЖУЮ
покупку: Malchezaar `BG26_524` и Bazaar Dealer `BG28_905` на борде,
наклейки `BG32_MagicItem_821`/`822`, тринкеты `BG30_MagicItem_701`
и `BG35_MagicItem_152`, боевой клич `BG32_893`. Поэтому читать надо тег,
а не текст.

По фикстурам тег встречается в part22, part23, part24, part25, part27
и part29 — и всюду только на `BG28_571`.

**Ловушка:** тег переставляется вместе с остальными на переходе хода
(«… value=0», следом «… value=1» — 01:13:30), и снимок, взятый между
двумя строками, прочитает `false`. Это общее свойство потока тегов,
а не особенность этого.

## Пара под тройку считается и по РУКЕ: BACON_PAIR_CANDIDATE

Игра сама помечает карту витрины, которая соберёт нам пару или тройку, —
тег `BACON_PAIR_CANDIDATE=1` на миньоне витрины. Важно, ЧТО она при этом
считает: копии **на борде и в руке**, а не только на борде.

Проверено прогоном по двум фикстурам (снимок на каждой строке, меняющей
зоны и теги пары):

| партия | пара помечена, копия только в РУКЕ | только на борде | копии не найдено |
|---|---|---|---|
| part29 | 1 (ход 23, `BG31_330`) | 5 | 0 |
| part22 | 6 (`BG32_330`, `BGS_004`, `BG36_764`, `BG26_137`, `BGS_020`, `BG35_142`) | 4 | 0 |

Ни одного случая «пара без копии» — то есть тег не шумит, а копии руки
он действительно считает. Отсюда следствие для советника: держать вторую
копию в руке ничем не хуже, чем на борде, а слот на борде она тратит
навсегда.

## Сила-вариант: новая сущность каждый ход, смена силы ивентом (part30)

У Крысиного короля (`TB_BaconShop_HERO_12`) сила «A Tale of Kings»
`TB_BaconShop_HP_041` меняет племя каждый ход, и в логе это НОВАЯ сущность
варианта в начале каждого хода таверны: `TB_BaconShop_HP_041b` (King of
Mechs), `…041g` (Pirates), `…041i` (Quilboar), `…041j` (Naga), `…041h`
(Elementals). `COST=2` живым тегом на каждой; отработавший вариант уходит
из `PLAY`, и «своя сила героя» редьюсера (первая живая `HERO_POWER` под
нашим контроллером) каждый ход читается правильно без специальной ветки.
Нажатие — обычный блок `PLAY` на сущности варианта: 10 нажатий за партию,
все на `…041x`.

Две ловушки рядом, обе проверены на part30 и НЕ потребовали правок:

- **Ивентная карта МЕНЯЕТ силу героя посреди партии.** «Сорванная маска»
  `EBG_Spell_037` (20:19:40, ход 23) открывает выбор из чужих сил: копии
  приходят сущностями `HERO_POWER` в `SETASIDE` под нашим контроллером
  с `WAS_DISCOVER_OPTION=1`. С хода 25 сила игрока — честно
  «Enhancification» `BG24_HERO_204p` (пассивная, без `COST`), и состояние
  это отражает: это не «лишняя сущность врёт» (part26), а настоящая смена.
- **`heroPowerUsedThisTurn` на точке решения бывает `true` при нетронутом
  золоте** — и это порядок строк, а не фантом: флаг ставится на
  `BLOCK_START BlockType=PLAY`, а `RESOURCES_USED` приходит строкой ПОЗЖЕ
  внутри того же блока. «Последнее состояние до первой траты» поэтому
  может уже нести флаг нажатия (part30, ходы 21 и 23).

## Заклинание по ВИТРИНЕ: Target=0, энчанты на player=10 (part30)

Them Apples `BG28_966` («Give minions in the Tavern +{0}/+{1}») цели
не имеет и бьёт по магазину — лог отдаёт это прямо (20:07:10):

```
BLOCK_START BlockType=PLAY Entity=[… cardId=BG28_966 player=2] … Target=0
    BLOCK_START BlockType=POWER …
        FULL_ENTITY - Creating ID=6315 CardID=      ← энчант
        TAG_CHANGE Entity=[… cardId=BG32_237 player=10] tag=LAST_AFFECTED_BY value=3191
        TAG_CHANGE Entity=6315 tag=TAG_SCRIPT_DATA_NUM_1 value=1
        TAG_CHANGE Entity=6315 tag=TAG_SCRIPT_DATA_NUM_2 value=2   ← +1/+2
```

Получатели — миньоны `player=10` (витрина), значения — `NUM_1`/`NUM_2`
энчанта. Совет по такому заклинанию не имеет права называть цель
на нашем борде.

## Сила героя на СВОЕГО миньона, EXHAUSTED на силе, тринкет за золото (part32)

**Сила с целью на своём борде.** «Ритуал перерождения» Короля-лича
`TB_BaconShop_HP_024` («Give a minion Reborn until next turn») создаётся
вместе с героем: `CARDTYPE=HERO_POWER`, `HAS_ACTIVATE_POWER=1`, тега `COST`
нет вовсе (бесплатна — тот же признак, что у Хроми part13 и Тавиша part29).
Нажатие — блок `PLAY` на сущности силы с `Target=` СВОИМ миньоном
(`player=8`, зона `PLAY`), на цели появляется энчант `TB_BaconShop_HP_024e2`
(«Reborn until next turn»); 16 нажатий за партию — 16 блоков:

```
23:49:36 BLOCK_START BlockType=PLAY Entity=[entityName=Ритуал перерождения id=121 … cardId=TB_BaconShop_HP_024 player=8]
         … Target=[entityName=Бликостраж id=307 zone=PLAY zonePos=1 cardId=BG29_888 player=8] SubOption=-1
```

**`EXHAUSTED` на силе — впервые.** До part32 запись гласила, что тег
`EXHAUSTED` на силах в фикстурах не встречается ни разу. Здесь он есть:
`EXHAUSTED=1` на силе сразу после блока PLAY (23:49:36) и `EXHAUSTED=0`
в начале следующего хода таверны (23:49:51). «Нажато в этом ходу»
по-прежнему считается блоком PLAY — так работает на всех силах, включая
те, где тега нет, — а тег записан как подтверждение, не как источник.

**Тринкет стоит ЗОЛОТА, и цена — тег `COST` на его сущности.** Предложение
хода 11 (23:54:17): два варианта в `SETASIDE` с `BACON_TRINKET=1`
и живой ценой при создании — `COST=4` (Baleful Incense `BG32_MagicItem_360`,
рядом `TAG_LAST_KNOWN_COST_IN_HAND=4`) и `COST=2` (Transcribing Typewriter
`BG35_MagicItem_931`). Выбор — `DebugPrintEntitiesChosen` (23:54:54),
следом трата БЕЗ блока PLAY: верхнеуровневый `TAG_CHANGE … tag=RESOURCES_USED
value=4` (23:54:55), `BACON_FIRST_TRINKET_DATABASE_ID=120137` на герое,
`NUM_RESOURCES_SPENT_THIS_GAME` растёт на те же четыре. Золото состояние
читает верно (`RESOURCES − RESOURCES_USED`), а совет по выбору тринкета
цены не знает — на скриншоте хода 11 у игрока 4/8 при витрине точки
решения, которая видела 8.

## Пассивная сила героя: START_OF_COMBAT на сущности, TRIGGER в начале боя (part33)

**Пассивность — тегами, а не отсутствием чего-то одного.** «Назойливые
мухи» Ал'акира `TB_BaconShop_HP_086` («Start of Combat: Give your left-most
minion Windfury, Divine Shield, and Taunt») создаётся вместе с героем
(01:08:59) как `CARDTYPE=HERO_POWER` с тегами `START_OF_COMBAT=1`,
`BACON_HERO_POWER_ACTIVATED=1`, `HIDE_COST=1`, `BACON_HEROPOWER_BASE_HERO_ID`;
тегов `HAS_ACTIVATE_POWER` и `COST` нет. За партию на силе ни одного блока
`PLAY` (у активных сил — по блоку на нажатие: part8, part13, part29, part32),
и `heroPowerHasActivate` в состоянии честно `false`.

**Срабатывание — блок `TRIGGER` на сущности силы в начале каждого боя**,
11 боёв — 11 блоков (01:10:13 … 01:28:38). Внутри: `META_DATA Meta=TARGET`
с `Info[0]` — свой миньон с `zonePos=1`, на нём `WINDFURY=1`, `TAUNT=1`,
`DIVINE_SHIELD=1`, следом энчант `TB_BaconShop_HERO_76_Buddy_e`
(`CARDTYPE=ENCHANTMENT`, `ATTACHED=<миньон>`, `CREATOR=<id силы>`,
`CREATOR_DBID=64402`), зона `SETASIDE → PLAY`:

```
01:10:13 BLOCK_START BlockType=TRIGGER Entity=[entityName=Назойливые мухи id=137 … cardId=TB_BaconShop_HP_086 player=6] … Target=0 SubOption=-1
             META_DATA - Meta=TARGET Data=0 InfoCount=1
                 Info[0] = [entityName=Раскаленный валун id=307 zone=PLAY zonePos=1 cardId=BGS_127 player=6]
             TAG_CHANGE Entity=[… id=307 … cardId=BGS_127 …] tag=WINDFURY value=1
             TAG_CHANGE Entity=[… id=307 …] tag=TAUNT value=1
             TAG_CHANGE Entity=[… id=307 …] tag=DIVINE_SHIELD value=1
             FULL_ENTITY - Creating ID=669 CardID=   →  SHOW_ENTITY … CardID=TB_BaconShop_HERO_76_Buddy_e, ATTACHED=307, CREATOR=137
```

К следующей таверне слов на миньоне нет (ход 9 и ход 11: Molten Rock 3/4
без признаков) — эффект живёт один бой. Цели по боям: ходы 2–10 Molten Rock
`BGS_127`, 12–20 Wildfire Elemental `BGS_126`, 22 Living Prison `BG36_180`
— всегда крайний левый, игрок ставил его туда сам.

**Следствие для эпизодов боя.** `readBattleEpisodes` снимает свой борд
в начале боя, ПОСЛЕ этого триггера, — в эпизоде хода 10 Molten Rock уже
стоит с провокацией, щитом и вихрем (`demo:phase3` печатает «пщв»). Живой
путь берёт борд из таверны, где слов ещё нет, и симулятор кладёт их сам;
оффлайн-перебор расстановок по эпизоду на этом герое переставляет миньона
С уже полученными словами, а симулятор дарит их ещё и новому крайнему
левому — сверка расстановки по эпизодам part33 из-за этого мягче правды.
Калибровку «как стоит» это не трогает: симулятор второй раз слова не даёт.

## Сила «после N покупок — награда»: счётчик на силе, TEMP_RESOURCES у игрока (part34)

**«Бранное дело» `TB_BaconShop_HP_048`** («After you buy 4 Battlecry
minions, get a Brann Bronzebeard. (Once per game.)») создаётся вместе
с героем (01:47:48, `Укротитель львов Бранн` `TB_BaconShop_HERO_43_SKIN_G`)
как `CARDTYPE=HERO_POWER` с тегами `TRIGGER_VISUAL=1`, `SCORE_VALUE_1=4`
(сколько покупок нужно), `HIDE_COST=1`, `BACON_HEROPOWER_BASE_HERO_ID=60214`;
тегов `HAS_ACTIVATE_POWER`, `COST` и `TAG_SCRIPT_DATA_NUM_1` при создании
НЕТ — остаток счётчика до первой покупки читается только из текста.

**Счётчик — `TAG_SCRIPT_DATA_NUM_1` на силе, пишется блоком TRIGGER силы
ВНУТРИ блока покупки** (`BLOCK_START BlockType=PLAY … TB_BaconShop_DragBuy`
→ `BLOCK_START BlockType=POWER` → … → `BLOCK_START BlockType=TRIGGER
Entity=[… cardId=TB_BaconShop_HP_048]`), вместе с `SCORE_VALUE_2` (сколько
уже куплено) и `USE_ALTERNATE_CARD_TEXT=1`:

| время | покупка | `NUM_1` | `SCORE_VALUE_2` |
|---|---|---|---|
| 01:48:04 (ход 1) | Southsea Busker `BG26_135` | 3 | 1 |
| 01:49:00 (ход 3) | Southsea Busker | 2 | 2 |
| 01:49:03 (ход 3) | Aureate Laureate `BG32_236` (без клича) | — | — |
| 01:49:42 (ход 5) | Southsea Busker | 1 | 3 |
| 01:50:54 (ход 7) | Shell Collector `BG23_002` | 0 | 4 |

Покупка без клича счётчика не трогает: на Laureate ни блока TRIGGER
на силе, ни смены тегов. Считается ПОКУПКА, а не розыгрыш: Busker хода 3
был продан через две секунды (01:49:02, `DragSell`), и счётчик его засчитал.

**Награда — тем же блоком TRIGGER, что и ноль счётчика** (01:50:54,
`EffectIndex=1`): `FULL_ENTITY - Creating ID=1701 CardID=BG_LOE_077`
в `ZONE=HAND` с `CREATOR=226` (сила) и `CREATOR_DBID=60218`, `TECH_LEVEL=5`,
`IS_BACON_POOL_MINION=1`, `AURA=1`, следом энчант `TB_BaconShopBadsongE`
на нём (розыгрыш бесплатен — part16). На силе тут же `HERO_POWER_DISABLED=1`
и `USE_ALTERNATE_CARD_TEXT=0` — «Once per game» отработало. Сила
остаётся в `PLAY` до 02:14:23, когда событие партии уводит её в `SETASIDE`
и даёт игроку чужие силы (`TB_BaconShop_HP_020`, затем `BG20_HERO_202p`
«Power of the Storm» с выбором каждый ход) — тот же класс, что «Сорванная
маска» в part30.

**`TEMP_RESOURCES` — временное золото хода, и редьюсер его не читал.**
«Battlecry: Gain 1 Gold next turn» (Busker) кладёт в начале следующего
хода `TAG_CHANGE Entity=AngryMem#2886 tag=TEMP_RESOURCES value=1`
(01:48:36 ход 3, 01:49:23 ход 5, 01:50:25 ход 7), при `RESOURCES=4/5/6`.
Тратится оно ПЕРВЫМ: подъём на тир 2 за 3 в 01:49:41 пишет
`TEMP_RESOURCES value=0` и `RESOURCES_USED value=2` — три золота =
один временный плюс два обычных. Продажа при нуле потраченного тоже идёт
сюда, а не в `RESOURCES_USED` (01:56:12: `DragSell` → `TEMP_RESOURCES=1`
при `RESOURCES_USED=0`; следом подъём за 10 → `TEMP=0`, `USED=9`).
В part30 Careful Investment ×3 дают `TEMP_RESOURCES=6` на ходу 23
(20:15:33), и покупки/продажи гуляют по нему 6 → 7 → 8 → 6 → 7 → 6
при `RESOURCES_USED=0`. Тег с ненулевым значением встречается в 29
фикстурах; границы хода с ненулевым остатком — ни одной (проверено
part22/27/30/34: сброс в ноль всегда до смены `TURN`).

Итого золото = `RESOURCES` + `TEMP_RESOURCES` − `RESOURCES_USED`
(пункт 10 в CLAUDE.md уточнён). До правки ход после Busker читался
на монету беднее (part34, ход 3: 4 вместо 5; ход 7: 6 вместо 7),
а продажа первым действием хода — как ничего не давшая.

**Три «Southsea Busker» и `BACON_PAIR_CANDIDATE`.** Не проверялось —
здесь тройка не собиралась: Busker хода 3 продан сразу.

## Заклинания в руке и плейсхолдеры текстов

Заклинания приходят обычными сущностями с `CARDTYPE=SPELL`. Факты part10:

- Монетка таверны (`BG28_810`) создаётся в `HAND` с `CARDTYPE=SPELL`
  и `COST=1`, который затем падает до нуля тегом — цену читать живую,
  из тега, а не из снапшота.
- Плейсхолдеры `{0}`/`{1}` в текстах снапшота — индексы значений
  `TAG_SCRIPT_DATA_NUM_1..2` на сущности: у «Buy the Holy Light»
  («+{0} Attack…») десятка лежит в NUM_1, у Тавматургии («+{1}/+{1}»)
  единица улучшения — в NUM_2 и растёт по ходу партии.
- Выбор сокровищ (три заклинания «Выберите одно») идёт тем же каналом
  `DebugPrintEntityChoices`, что и остальные модальные выборы; источником
  может быть тринкет (part10: «Наклейка с Билетикусом», BG30_MagicItem_707).
- Золотой миньон встречается и В ВИТРИНЕ: Aureate Laureate (BG32_236)
  всегда золотая — тег `PREMIUM` на чужом миньоне в `PLAY` в фазе таверны.

## Заряды тёмного дара, смертники и заклинания витрины (part11)

- **Заряды дара** — `TAG_SCRIPT_DATA_NUM_2` на кнопке `BG36_Button_DarkGift`:
  3 при создании, по единице за нажатие (part11: 3→2→1→0). После нуля кнопка
  ОСТАЁТСЯ в `PLAY` с ценой в `COST` — совет по одной цене был тихо неверным.
- **Карты-смертники** — энчант `TB_BaconShopBadsongE` на карте в руке:
  «умрёт, если разыграть в этот ход». Вешается картой-источником
  («Восстание из гробницы» BG34_888, сила Сильваны) и НЕ снимается на
  следующий ход — ход получения отличает `NUM_TURNS_IN_HAND=1`.
- **У заклинаний ДВА типа**: в руке `CARDTYPE=SPELL`, в витрине —
  `BATTLEGROUND_SPELL`. Витринные — единственные карты магазина с ценой
  в логе: живой тег `COST` (монетка за 1, баффы за 1–3).
- **Плейсхолдеры текстов доходят до `{3}`** («+{0}/+{1}; or +{2}/+{3}»
  у Alliance Flag) — значения в `TAG_SCRIPT_DATA_NUM_1..4`.
- **Тег `CARDRACE` несёт племя СТРОКОЙ** (UNDEAD, QUILBOAR, NAGA…) — и
  механизмы здесь называются `MECHANICAL`, тогда как в `races` снапшота —
  `MECH`. Частоты CARDRACE за партию повторяют состав племён лобби
  (part11: UNDEAD/QUILBOAR/NAGA/MURLOC/DEMON; part10:
  DRAGON/NAGA/UNDEAD/ELEMENTAL/PIRATE) с шумом от чужих героев — точным
  источником могли бы быть только миньоны витрины.

- **Кнопка дара живёт с первого хода, заряды — числом** (part31, 21:28:33):
  `FULL_ENTITY … cardId=BG36_Button_DarkGift` создаётся уже на первом ходу
  с `COST=3`, `TAG_SCRIPT_DATA_NUM_1=6` и `TAG_SCRIPT_DATA_NUM_2=3`; до третьего
  хода таверны нажатие отбивает `REQ_MINIMUM_GAME_TURN` (part23). Нажатия
  игрока в part31 — 21:42:51 (ход 19), 21:45:20 (ход 21), 21:47:41 (ход 23),
  и после каждого через ~10 секунд `NUM_2` 3 → 2 → 1 → 0 (выбор из трёх
  открыт между нажатием и списанием заряда). Заряды теперь в состоянии
  (`darkGiftCharges`) — советник считает по ним цену придержанного заряда.
- **Продажа ради подъёма** (part31, ход 13, 21:36:13–21:36:14): при девяти
  золотых и цене подъёма 10 игрок продал Rodeo Performer
  (`TB_BaconShop_DragSell`, `Target=[… BG28_550]`) и следующей секундой
  нажал `TB_BaconShopTechUp05_Button` — золото 9 → 10 → 0. Точка решения
  хода из-за этого сдвигается ЗА продажу: «последнее состояние до первой
  траты» видит борд уже из шести, а скриншот был снят при семи.
- **Заклинание витрины «Discover a Tier 1 minion»** — A New Sprout
  `BG33_101`, `BATTLEGROUND_SPELL` с `COST=3` (не дешевле покупки), тир 1
  в снапшоте, при таверне 4 в витрине хода 13. Игрок его не купил.

## Племя тринкета: BACON_SUBSET_<RACE> на сущности (part12)

У тринкетов с племенным эффектом на сущности стоит `BACON_SUBSET_<RACE>=1`:
`BACON_SUBSET_DRAGON` у «Разноцветного компаса» и «Драконьего планера»,
`BACON_SUBSET_MECH` у Scraper Sticker (part9). Это надёжнее текста: у
компаса племя в тексте — плейсхолдер `{0}`. Имена в тегах совпадают
со строками `races` снапшота — `MECH`, а не `MECHANICAL` из `CARDRACE`.

Прежняя запись «`BACON_SUBSET_*` висят на миньонах и означают
принадлежность карты к подмножеству» остаётся верной — на тринкетах тот же
тег называет племя ЭФФЕКТА.

## DebugPrintOptions

Перечисляет все доступные игроку действия с полными дескрипторами:

```
option 0 type=END_TURN mainEntity= error=INVALID errorParam=
option 1 type=POWER mainEntity=[… cardId=TB_BaconShop_HP_103 player=3] error=NONE
option 2 type=POWER mainEntity=[… cardId=TB_BaconShop_8p_Reroll_Button player=3] error=NONE
option 3 type=POWER mainEntity=[… cardId=TB_BaconShopLockAll_Button player=3] error=NONE
option 4 type=POWER mainEntity=[… id=408 zonePos=1 cardId=BG35_814 player=11] error=NONE
```

Потенциально это самый прямой способ узнать содержимое магазина и что сейчас доступно.

## Замок «Unlocks at Tier N» на силе героя: LOCK_VISUAL (part37)

Часть сил открывается не сразу: у Алекстразы «Королева драконов»
`TB_BaconShop_HP_064` — «Discover a Dragon. *(Unlocks at Tier 4.)*»,
у E.T.C. «Sign a New Artist» `BG25_HERO_105p` — «Discover a Buddy.
*(Unlocks at Tier 2.)*».

**По тегам доступности такая сила неотличима от обычной.** При создании
(part37, 21:16:15) на ней стоят `HAS_ACTIVATE_POWER=1` и `COST=1`, а тега
`LITERALLY_UNPLAYABLE` не приходит НИ РАЗУ за партию. Замок — свой тег:

```
FULL_ENTITY - Creating ID=151 CardID=TB_BaconShop_HP_064
    tag=COST value=1
    tag=HAS_ACTIVATE_POWER value=1
BLOCK_START BlockType=TRIGGER Entity=151 …
    TAG_CHANGE Entity=151 tag=LOCK_VISUAL value=1      ← 21:16:15, замок
BLOCK_END
…
BLOCK_START BlockType=TRIGGER Entity=[… id=151 …] …
    TAG_CHANGE Entity=151 tag=LOCK_VISUAL value=0      ← 21:21:26, тир 4
```

Триггер срабатывает на КАЖДОМ подъёме тира (21:17:53 — тир 2, 21:19:45 —
тир 3, 21:21:26 — тир 4), но пустым блоком; тег меняется только на нужном
тире, и в тот же миг, что `PLAYER_TECH_LEVEL value=4` (строки 34642
и 34681 одного времени).

**Тег общий для «кнопок под замком»**, а не только для сил: та же пара
стоит на кнопке тёмного дара `BG36_Button_DarkGift` во всех фикстурах
(замок при создании, снятие на пятом ходу партии — там же приходит
`LOCK_VISUAL_STATE`). Видно и чужие силы: у сил соперников в `SETASIDE`
замок стоит своей причины. У сил, доступных сразу, тега нет вовсе
(part13, Хроми) — умолчание «замка нет» честное.

**Причину замка называет `DebugPrintOptions`**, и это отдельный канал:

```
option 13 type=POWER mainEntity=[entityName=Королева драконов id=151 …]
    error=REQ_MINIMUM_TAVERN_TIER_LEVEL_TO_PLAY errorParam=
```

За партию таких строк 15 (part37) и 3 (part12) — они и есть дешёвый
маркер «в этой партии сила была под замком». В состояние читается всё-таки
`LOCK_VISUAL`: канал опций тесты не разбирают, а тег приходит обычным
`TAG_CHANGE` в основном канале и отвечает на нужный вопрос — жать нельзя,
— не разбирая, почему.

## Альтернативная таверна подменяет пул золота (part25, part41)

«Альтернативная история» (`BACON_ALT_TAVERN_IN_PROGRESS`) — отдельный экран
со своей валютой, и в логе она выглядит как временная подмена ОБЫЧНОГО
золота. Блок TRIGGER на сущности «Альтернативная история» ставит тег партии
и тут же переписывает ресурсы игрока:

```
BLOCK_START BlockType=TRIGGER Entity=[entityName=Альтернативная история …]
    TAG_CHANGE Entity=GameEntity tag=BACON_ALT_TAVERN_IN_PROGRESS value=1
    TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES value=0
    TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES value=2
    TAG_CHANGE Entity=AngryMem#2886 tag=BACON_ALT_TAVERN_COIN value=2
```

Дальше игрок тратит эти две монеты (`RESOURCES_USED` 0 → 1 → 2), после чего
`RESOURCES` возвращается к обычному максимуму хода, а счётчик трат — к нулю.
То есть для всякого, кто считает «золото тронуто», это ЛОЖНАЯ трата: своё
золото хода целое, а счётчик успел вырасти и упасть.

Числа: тег встречается в двух партиях из 39 (part25 и part41, по два входа),
и оба раза внутри хода таверны 15. Именно поэтому механику стоит держать
в голове при любом правиле про золото — она редкая ровно настолько, чтобы
не попасть в выборку, на которой правило проверяют, и всё-таки сломать его
раз в двадцать партий. В состояние читается признак `altTavern`
(`src/state/types.ts`); правило точки решения без него теряло законную точку
каждого такого хода (05.09.2026).

## Счётчик трат УМЕНЬШАЕТСЯ при продаже (part34, part39)

`RESOURCES_USED` — не «сколько потрачено за ход», а живой счётчик, который
продажа гонит назад: возврат за проданного миньона гасит потраченное, и при
достаточном размене счётчик доходит до НУЛЯ, а излишек приходит временным
золотом (`TEMP_RESOURCES`). Пример — part39, ход 1 (максимум хода 3 золота):

```
потрачено 0, золото 3/3   ← точка решения
потрачено 1, золото 2/3   ← нажата сила героя за 1
потрачено 0, золото 3/3   ← счётчик вернулся
потрачено 0, золото 7/3   ← бросок кубика: временное золото
потрачено 3, золото 4/3   ← покупка
```

Отсюда правило для всех, кто ищет «состояние до первой траты»: трата — это
РОСТ счётчика внутри одного хода, а не его величина. Границу хода при этом
надо брать базой, а не тратой: на первом событии нового хода счётчик ещё
несёт значение прошлого (part39, ход 3: «потрачено 3» при золоте 1/4).

## Шум, который надо игнорировать

- `PowerProcessor.DoTaskListForCard() - unhandled BlockType PLAY for sourceEntity […]` —
  это клиент не нашёл анимацию, не ошибка парсинга.

## Конец партии — подтверждено человеком

Партия 1 из фикстур, `segment4.log`, 03.08.2026:

```
TAG_CHANGE Entity=AngryMem#2886 tag=PLAYSTATE value=LOST
TAG_CHANGE Entity=Shockwave     tag=PLAYSTATE value=WON
TAG_CHANGE Entity=GameEntity    tag=NEXT_STEP value=FINAL_GAMEOVER
TAG_CHANGE Entity=[… Лесной властелин Кенарий … cardId=BG32_HERO_001 …]      PLAYER_LEADERBOARD_PLACE=1
TAG_CHANGE Entity=[… Змееуст Вайш … cardId=BG23_HERO_304_SKIN_B …]           PLAYER_LEADERBOARD_PLACE=2
TAG_CHANGE Entity=[… Алекстраза … cardId=TB_BaconShop_HERO_56 …]             PLAYER_LEADERBOARD_PLACE=3
TAG_CHANGE Entity=[… Благой Фаэлин … cardId=BG22_HERO_201_SKIN_D player=6]   PLAYER_LEADERBOARD_PLACE=4
TAG_CHANGE Entity=GameEntity    tag=STEP value=FINAL_GAMEOVER
```

Игрок подтвердил: он играл Благим Фаэлином и занял 4-е место.

Финал отмечается `STEP`/`NEXT_STEP` со значением `FINAL_GAMEOVER`, а собственный исход —
тегом `PLAYSTATE` на сущности с BattleTag игрока. **Это самый надёжный признак**: там
игрок назван по имени аккаунта, без посредников в виде героя или номера контроллера.

Правило «свой герой лежит в `zone=PLAY`, чужие в `SETASIDE`» верно, но с двумя оговорками,
вскрывшимися на партии 2:

1. Оно справедливо **в момент** `STEP=FINAL_GAMEOVER`. Сразу после герой уезжает
   в `GRAVEYARD`.
2. **`cardId` героя на концовке перестаёт быть уникальным.** В партии 2 под одним
   контроллером прошли две сущности с `cardId=TB_BaconShop_HERO_70_SKIN_H`:
   `id=94` — настоящий герой, 2812 упоминаний за партию, и `id=16441` — 20 упоминаний,
   все в концовке. Второй создан на 96% файла внутри `BLOCK_START BlockType=DEATHS`
   по триггеру `BaconShop8PlayerEnchant`, сразу в `SETASIDE`: служебная копия на момент
   вылета игрока. Своего героя надо брать по сущности, живущей всю партию, а не по `cardId`.

## Реконнект

Сегменты 2–4 партии 1 начинаются с полного дампа состояния: `DebugPrintPowerList - Count=177`
против `Count=44` при обычном старте партии. Благодаря этому части сшиваются по состоянию,
а не по непрерывности событий, и провалы в 1–3 минуты между ними не ломают восстановление.

**Устройство дампа** (part1, сегмент 2): внутри `CREATE_GAME` идут блоки-заголовки
`GameEntity EntityID=16` и `Player EntityID=17 PlayerID=6 GameAccountId=[…]`,
за каждым — строки-продолжения `tag=… value=…`. Именно этими строками дамп несёт
всё состояние: `TURN`, `PLAYER_TECH_LEVEL`, `HERO_ENTITY` (на блоке Player!),
`BACON_MAX_PLAYER_TECH_LEVEL`. Дальше следуют обычные `FULL_ENTITY` всех сущностей.
Разбор, знающий `HERO_ENTITY` только как `TAG_CHANGE`, оставляет партию после
реконнекта без героя, а тир — единицей до первого живого события: ровно так
парсер и жил до тестов состояния part1.

**`PLAYER_LEADERBOARD_PLACE` живёт всю партию** как текущее место в таблице
(part1, сегмент 1: значение 3 посреди игры), финальным становится только
на `FINAL_GAMEOVER`. Показывать его как финальное раньше нельзя.

Скорость роста `Power.log` в BG растёт по ходу партии — борды больше, событий на ход больше:

| фаза партии | скорость | запас до предела |
|---|---|---|
| начало, ходы 1–11 | ≈1.1 МБ/мин | ≈9 минут |
| середина, ходы 12–21 | ≈2.0 МБ/мин | ≈5 минут |
| конец, ходы 22+ | ≈3.2 МБ/мин | ≈3 минуты |

То есть перезапускаться надо не по часам, а по факту: каждые ~3 минуты к концу партии.

## Магазин, свой борд и борд противника

Все трое живут в одной зоне `PLAY` и различаются контроллером и фазой.

**Свой борд** — миньоны под своим контроллером. Герой занимает `zonePos=0`,
миньоны идут с 1.

**Магазин** — миньоны под чужим контроллером во время таверны. Подтверждено прямо,
блоком покупки:

```
BLOCK_START BlockType=PLAY Entity=[entityName=Перетащите, чтобы купить … player=4]
    Target=[entityName=Слизнюченыш-гладиатор id=10412 zone=PLAY zonePos=2 … player=12]
    TAG_CHANGE Entity=AngryMem#2886 tag=RESOURCES_USED value=6
```

Покупается именно миньон в `PLAY` под чужим контроллером; кнопка покупки
`TB_BaconShop_DragBuy` принадлежит игроку, а её `Target` — товар. Таких блоков
за партию 46.

**Борд противника** — те же чужие миньоны в `PLAY`, но во время боя. Отличить
магазин от борда противника можно **только по фазе**: зона и контроллер у них
совпадают. Это согласуется с устройством второго слота `Player`, который в таверне
занят Бобом, а на бой переключается на оппонента.

### Замороженная витрина дозаполняется до размера витрины своего тира

Проверено 26.08 по всем девятнадцати заморозкам шести партий (part17, part19,
part22, part24, part25, part27): замороженные миньоны на следующем ходу
возвращаются **новыми сущностями** с теми же `cardId` (у part27, ход 1→3:
Risen Rider `#412` → `#769`, Harmless Bonehead `#416` → `#771`), а пустые
слоты — купленные в этот ход и добавленные подъёмом таверны — приходят
свежими картами до размера витрины тира (`shopSizeByTier`, 3/4/4/5/5):

| партия, ходы | тир | заморожено | витрина следующего хода | свежих |
|---|---|---|---|---|
| part27, 1→3 | 1→1 | 2 (куплен один) | 3 — те же два плюс Molten Rock | 1 |
| part27, 3→5 | 2→2 | 3 (подъём в ход заморозки) | 4 — те же три плюс Nerubian Deathswarmer | 1 |
| part19, 3→5 | 2→2 | 3 (подъём) | 4 — плюс Laboratory Assistant | 1 |
| part24, 3→5 | 2→2 | 3 (подъём) | 4 — плюс Soul Rewinder | 1 |
| part24, 13→15 | 4→4 | 3 (куплены два) | 5 — плюс Thousandth Paper Drake и Blue Whelp | 2 |
| part24, 15→17 | 4→4 | 5 (витрина полна) | 5 — те же пять | 0 |
| part17, 19→21 | 5→5 | 4 | 5 — плюс Roaring Recruiter | 1 |

Следствие для советника: держать витрину ради одной карты не значит
отказаться от свежей витрины целиком — купленный слот и слот подъёма всё
равно будут свежими, и первую покупку следующего хода игрок делает из них.
Планка заморозки ради «предложения дешевле покупки» считает это
(`freezeRule`, docs/tavern.md, двадцать первая порция).

Сущности заморозки — по-прежнему тег `FROZEN` на миньонах витрины; новые
сущности следующего хода приходят с ним же, пока витрину не обновят.

## Гипотезы — НЕ использовать в коде до подтверждения

1. Кто такой второй `PlayerID` формально — слот соперника или что-то шире.
   Практически ведёт себя как переиспользуемый слот, но полного описания нет.
2. Признак золотого миньона. Наблюдение: суффикс `_G` в `cardId` (`BG31_815_G`),
   но отдельного тега не искали.

## Пробелы — данных пока нет

Материал для них в фикстурах уже есть, разбор впереди:

- Переключение фаз таверна ↔ бой; момент «борд зафиксирован».
- Логируется ли перестановка миньонов мышкой, и как индексируется `zonePos`.
- Как выглядит бой: пошагово или только итог.
- Борд оппонента: когда виден, с какими статами.
- Известен ли следующий оппонент заранее.
- Энчанты: лежат ли в логе итоговые atk/hp или базовые + бафы.
- Золотые миньоны: отдельный cardId, тег, или и то и другое.
- Граница между партиями внутри одного файла.

### Закрыто

- ~~Конец партии и финальное место~~ — раздел «Конец партии», подтверждено человеком дважды.
- ~~Поведение при реконнекте~~ — раздел «Реконнект», полный дамп состояния.
- ~~Аномалия задана через dbId, нужен маппинг~~ — оказалось, есть и сущность с `cardId`.
- ~~Предел размера лога неустраним~~ — `client.config`, `Log.FileSizeLimit.Int`.
- ~~Кодировка и переводы строк~~ — UTF-8 без BOM, CRLF вперемешку с LF у баннера.
