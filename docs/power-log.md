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

Статус: ⚠️ **выведено из IL, на живой партии ещё не проверено.** Протокол проверки:
одна полная партия BG без перезапусков; успех = `Power.log` больше 10 250 000 байт,
баннера нет, `FINAL_GAMEOVER` в конце. До подтверждения реконнект-метод не хоронить.

Методическая заметка: строка `Log.FileSizeLimit.Int` не находилась обычным поиском,
потому что UTF-16-литералы в сборках лежат и по нечётным смещениям — сканировать надо
в обоих выравниваниях. Первые сканы этим страдали и пропустили в том числе сам текст
баннера.

### Что это значит на практике

Замеренная скорость роста `Power.log` при `Verbose=true` и одной только секции `[Power]`:

| режим | скорость | сколько влезает в 10 МБ |
|---|---|---|
| Battlegrounds | ≈1.17 МБ/мин | ≈9 минут, примерно до 13-го `TURN` |
| обычный рейтинг | ≈0.35 МБ/мин | 2–3 полные партии |

Полная партия BG идёт 20–30 минут, то есть **при `Verbose=true` она в лимит не влезает**.
Перезапуск клиента даёт новый файл, но не помогает внутри одной партии.

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

`GameState.*` и `PowerTaskList.*` дублируют одни и те же события — выбрать один канал
как источник истины, иначе теги применятся дважды. Какой именно — **не решено**.

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

- `entityName` **локализован** — опираться нельзя, только `cardId`.
- `cardId` присутствует прямо в дескрипторе.

Зоны, встреченные в `tag=ZONE value=`: `PLAY`, `HAND`, `SETASIDE`, `GRAVEYARD`, `REMOVEDFROMGAME`.
**Отдельной зоны под магазин таверны нет.**

## Игроки

```
GameState.DebugPrintGame() - PlayerID=3, PlayerName=AngryMem#2886
GameState.DebugPrintGame() - PlayerID=11, PlayerName=Клеопатра
```

Партия BG моделируется как игра двух «игроков». `PlayerID=3` — реальный аккаунт (BattleTag).

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

На `GameEntity` в `CREATE_GAME`: `GAME_SEED`, `BACON_GLOBAL_ANOMALY_DBID=119094`,
`BACON_BARTENDER_CARD_ID=57110`, `BACON_TRINKETS_ACTIVE=1`, `BACON_DUOS_PUNISH_LEAVERS=1`,
`BACON_MULLIGAN_HERO_REROLL_ACTIVE=1`.

⚠️ Аномалия задана через **dbId (119094), а не cardId** — нужен маппинг dbId→cardId из HearthstoneJSON.

Часть тегов приходит без имени, голым числом: `tag=937 value=3459`, `tag=1488 value=1`,
`tag=4730 value=5`. Парсер обязан переживать неизвестные числовые теги, а не падать на них.

## Известные cardId

- Слоты тринкетов: `BG30_Trinket_1st`, `BG30_Trinket_2nd`
- Призрак: `TB_BaconShop_HERO_KelThuzad` — лежит в `SETASIDE` заранее, ещё до боёв
- Кнопка реролла: `TB_BaconShop_8p_Reroll_Button`
- Кнопка заморозки: `TB_BaconShopLockAll_Button`
- Сила героя (пример): `TB_BaconShop_HP_103`
- Миньон (пример): `BG35_814`

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

Игрок подтвердил: он играл Благим Фаэлином и занял 4-е место. Отсюда следует правило,
которое **можно** использовать в коде, потому что оно проверено человеком:

> В финальном списке мест свой герой лежит в `zone=PLAY`, чужие — в `SETASIDE`.

Финал отмечается `STEP`/`NEXT_STEP` со значением `FINAL_GAMEOVER`, а собственный исход —
тегом `PLAYSTATE` на сущности с BattleTag игрока.

## Реконнект

Сегменты 2–4 партии 1 начинаются с полного дампа состояния: `DebugPrintPowerList - Count=177`
против `Count=44` при обычном старте партии. Благодаря этому части сшиваются по состоянию,
а не по непрерывности событий, и провалы в 1–3 минуты между ними не ломают восстановление.

Скорость роста `Power.log` в BG растёт по ходу партии — борды больше, событий на ход больше:

| фаза партии | скорость | запас до предела |
|---|---|---|
| начало, ходы 1–11 | ≈1.1 МБ/мин | ≈9 минут |
| середина, ходы 12–21 | ≈2.0 МБ/мин | ≈5 минут |
| конец, ходы 22+ | ≈3.2 МБ/мин | ≈3 минуты |

То есть перезапускаться надо не по часам, а по факту: каждые ~3 минуты к концу партии.

## Гипотезы — НЕ использовать в коде до подтверждения

1. **Магазин отличается от своего борда по `player=`.** Наблюдение: кнопки таверны, сила героя
   и слоты тринкетов идут с `player=3`, а покупаемый миньон магазина — с `player=11`.
   Проверять на диагностической партии, где известно, что было на экране.
2. Кто такой `PlayerID=11 / Клеопатра` — второй слот, магазин, текущий оппонент или что-то ещё.
3. Какой из каналов (`GameState` vs `PowerTaskList`) брать как источник истины.

## Пробелы — данных пока нет

Ждут полной партии и диагностической партии:

- Переключение фаз таверна ↔ бой; момент «борд зафиксирован».
- Логируется ли перестановка миньонов мышкой, и как индексируется `zonePos`.
- Как выглядит бой: пошагово или только итог.
- Борд оппонента: когда виден, с какими статами.
- Известен ли следующий оппонент заранее.
- Энчанты: лежат ли в логе итоговые atk/hp или базовые + бафы.
- Золотые миньоны: отдельный cardId, тег, или и то и другое.
- Конец партии и финальное место.
- Граница между партиями внутри одного файла.
- Поведение при реконнекте.
