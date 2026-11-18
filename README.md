# 13 — Mongol Poker (Монгол Покер)

A Big-Two-style card game for the [Usion](https://usions.com) platform,
open-sourced as a **best-practice reference** for building multiplayer mini-apps
with the [Usion SDK](https://www.npmjs.com/package/@usions/sdk) (`window.Usion`).

Three files, no build step: [index.html](index.html) · [script.js](script.js) · [style.css](style.css).

## Дуут яриа

Онлайн ширээ болон найзын хүлээлгийн өрөөнд 🎤 товчоор микрофоноо асааж,
нэг ширээний хүмүүстэй Muushig шиг ярилцана. Дахин дарахад дуут сувгаас гарна.
Анх ороход унтраалттай; ширээ солих, боттой тоглох руу гарах, холболт тасрахад
хаагдана. Нээлттэй ширээ бүр тусдаа `game` scope сувагтай, найзын өрөө `room`
scope ашиглана. Боттой офлайн үед харагдахгүй.

`Usion.call` native voice дэмждэг Usion апп шаардлагатай. Энгийн браузер болон
хуучин апп дээр микрофон товч харагдахгүй. Аудиог тоглоомын код бичиж хадгалахгүй;
холболт, микрофоны зөвшөөрлийг Usion хост удирдана.

Дуут сувгийн UI ба lifecycle шалгах: `node test/t_voice.cjs`. Энэ нь native API-г
mock хийдэг тул хоёр бодит утсаар аудио сонсогдохыг мөн шалгана.

> Товч монголоор: энэ бол Usion платформ дээрх «13» хөзрийн тоглоомын бүрэн эх
> код. **Чатаас уригдаж** орвол хуучин ёсоороо хүлээх танхим — бүгд БЭЛЭН дараад
> хост эхлүүлнэ. **Урилгагүй** зүгээр тоглоход **нээлттэй ширээ**: 3 боттой шууд
> эхэлж, дараа нь ирсэн хүн бүр хамгийн бага оноотой ботын суудлыг (оноо, хөзрийн
> хамт) авч тоглоомын дундаас ордог; гарсан тоглогчийн суудлыг бот эргүүлж авдаг
> тул ширээ хэзээ ч зогсдоггүй.

## Two rooms, one game

How the game was **launched** decides how its room behaves. Both modes run the
same engine, the same relay and the same recovery machinery — they differ only in
who is allowed to sit down.

| | **Chat invite** (`mode: 'multiplayer'`) | **No invite — "just play"** (`mode: 'single'`) |
|---|---|---|
| Where from | a game invite in a chat | Explore, the GameTok feed, the Play button |
| Which room | the **private** room the invite created (`config.roomId`) | a **shared public table** the game picks itself — see below |
| Getting started | a **waiting room**: everyone toggles READY, the host presses Start | none — the table **deals itself** a moment after you land |
| Seats | 2–4, exactly the people who were invited, **frozen at Start** | always **4**: humans first, bots in the rest |
| Somebody arrives | too late — they watch this match out | they **take over the bot with the fewest penalty points**, inheriting its score, its standing and the cards it is holding *right now*, mid-round |
| Somebody leaves | 20 s grace, then their seat **folds** out of the match | 20 s grace, then a **bot takes the seat and its score**, and play continues |
| Match length | the host picks 15 / 20 / 30 | fixed at 20 |
| When it ends | the winner screen, PLAY AGAIN | the table **restarts itself** a few seconds later |

Sharing mid-game *is* inviting, so a Share promotion (`onRoomAssigned`) moves an
open room over to the invite rules: the table is torn down and a waiting room
opens in the new room.

### Shared tables are Usion world rooms (since 2026-11-17)

The real relay admits only rooms that exist, and only their players (backend
`realtime/game_handlers.py` → `handle_game_join`: `ROOM_NOT_FOUND` /
`NOT_PARTICIPANT`). The ladder of made-up `public-13-N` rooms described below
therefore never seated anybody in production: every join failed and each player
fell back to their own room with three bots. The shared table is now a **world
room**: `Usion.game.joinWorld()` (`joinWorldTable()`) places a player in the world
they are already in, else a world with a free seat (max 4, from the service's
`game_config`), else a fresh one, and the server frees a seat when its player
leaves. Everything inside the table — bots, taking over the weakest bot,
restarting, clearing a dead room — is unchanged.

This needs the service tagged `world` + `private-invites` (13 has both since
2026-11-17; the server then stores `game_config.room_mode: "world"`,
`min_players: 1`). Chat invites and tournament tables are created with
`POST /games/rooms` and stay ordinary match rooms. **Saving the service in the
Service Creator drops the `world` tag** — re-add it through the API after any save.
Without world rooms (older SDK, tag missing) the game falls back to the ladder
below, which ends at the player's own room. `test/t_world.cjs` runs the open table
under the real rules (`World({ strictRooms: true, worlds: true })`).

### Why the open room picks its own room id (fallback only)

The platform hands **every** no-invite launch its own private `standalone_` room.
Joining that is what an open table must *not* do: two people who both tap Play
would sit in two different rooms, each alone with three bots, and the open table
could never fill. So the game ignores that room and joins a shared one it names
itself — a short ladder of public tables:

```
public-13-1, public-13-2, … public-13-8      (OPEN_ROOM_PREFIX / OPEN_ROOM_SHARDS)
```

**Arriving is a search, not a join.** The point of a public table is that the
next person to tap Play finds the one you are already sitting at — and that does
not happen by itself. Tables spread over the ladder, people leave gaps in it, and
a client that only ever looked at table 1 would open a brand-new table right next
to somebody playing alone with bots two rungs along. Neither would ever know.

Before joining, read the eight public tables' occupancy records in
`Usion.cloud.shared` and choose the **most populated table with a playable bot
seat**, like Muushig. Equal counts prefer the lower table number. One elected
seated client publishes each table's human count and available seats, refreshing
quiet tables every 15 seconds and coalescing changes over 5 seconds. Records
older than 45 seconds, full tables and invalid records are ignored. These are
occupancy hints, not seat reservations: the existing live join and seat-action
validation still decides whether the newcomer can actually sit down.

If shared storage is unavailable, takes over 1.5 seconds, or has no eligible
record, fall back to walking the ladder. The join acknowledgement decides what
happens:

| what the rung looks like | what we do |
|---|---|
| somebody here, a bot seat free | **stay** — this is the table we came for |
| somebody here, all four seats human | full, try the next rung |
| nobody here, never used at all | tables fill from the front, so nothing lies beyond this — the search is over |
| nobody here, but used before | remember it as somewhere to set up, and keep looking for actual people |

When the ladder holds nobody, we settle on the **lowest** empty rung we saw —
going back for it if we walked past — clear whatever is left in it and deal
against bots. Tables stay bunched at the front, so the next person's search is
short. The very first player probes exactly one rung and is dealt in immediately.

Two details that are easy to get wrong and were both bugs first: an
acknowledgement for a rung we are leaving must not be acted on (its roster and
checkpoint belong to a room we are walking out of), and neither must anything
still in flight from it (`joiningRoom` drops actions, syncs and realtime traffic
until the next room answers). Otherwise the search drags the previous table's
state along with it.

Once settled, a player still seatless after `OPEN_HOP_MS` **hops on** rather than
queuing behind strangers — but only when the table really is four humans. If a
bot is holding a seat they stay put, because one is about to come free.

### The search is allowed to be wrong

Two people playing bots at two different tables is the one outcome this whole
mechanism exists to prevent, and no amount of care over a single join
acknowledgement can rule it out. An ack can be stale. A relay can describe a room
differently than we assumed. Two searches can cross. So the design does not rely
on getting it right first time — it relies on **noticing and fixing it**:

> A player sitting **alone** anywhere but the front of the ladder waits
> `OPEN_REGROUP_MS` and then walks back and searches again.

Whoever guessed wrong drifts down to the front, where everybody looks first, and
the two tables become one. Sitting alone is what makes this free: the seat we
vacate turns into a bot and the table we leave is a ghost the next arrival clears
out, so nobody else notices. Three things keep it from becoming churn — a player
alone **at** the front stays put (they are already where searches land), a table
with company never moves, and it only happens at a round boundary unless the wait
has run to twice `OPEN_REGROUP_MS`.

The same principle bounds the failure modes elsewhere: **nothing ever clears out a
table other people are sitting at.** Every "this room is dead" path reaches that
conclusion from presence and connection counts, and being wrong there would wipe
somebody's live game — so `reopenOpenTable()` refuses outright when another human
holds a seat. A client that cannot get seated moves on instead.

If the host refuses a room id of our choosing, we fall back to the room it gave
us (a private table with bots — a game, just not a shared one); if the relay is
unreachable at all, we fall back to the same table played locally.

**A dead room is cleared, not resumed.** The relay keeps a table's action log and
checkpoint after everybody has left it, so tapping Play again would drop you back
into the leftovers of your own finished match — your old score, your old
elimination, and seats still held by people who are not there. Nothing in that
table will ever move, because the players it is waiting on are gone. So if we are
the only one connected and the roster names anybody else, the room is finished:
`openRoomIsAbandoned()` spots it and `reopenOpenTable()` deals a fresh match seated
on whoever is actually present. Two guards keep that off live tables — the
server's `connected_count` (not presence, which is built from the relay's frozen
roster and cannot tell a live opponent from a ghost), and a full forfeit-grace
window after anybody drops, because an *eliminated* seat gets no grace of its own
and a reconnecting peer must not have the room wiped out from under them.

**And it is never just a spinner.** The connect cover exists for the fraction of
a second it takes to find a table — no READY, no host tag, no match-length picker,
because there is nothing there for the player to decide. Three things make sure it
stays that short: an empty rung holding only a stale log is claimed in about two
seconds; a table that owes us a seat is waited on rather than abandoned; and if
after `OPEN_STUCK_MS` nobody anywhere will seat us — a peer on an older build, a
wedged authority, a relay refusing our claims — we stop asking and take a table
over ourselves. Note that we stay **online** to do it: dropping to a local game
would make us invisible to the next person's search, which is the one thing
matchmaking must never do. Only an unreachable relay falls back that far.

**A table can never be locked, either.** Two friends on a road-to-20 table knock
the bots out after a few rounds, and an eliminated seat cannot be handed to
anybody: it holds no cards, so its new owner would sit there with nothing to play.
Rather than turn the newcomer away, the table deals a **fresh match**
(`openResetForWaiting()`, between rounds and rate-limited), putting every bot seat
back in play and the newcomer straight into one. The match that gets reset was
nearly over anyway; a room two people can close is worse.

## Тэмцээн (Tournament)

Цэсний **Тэмцээн** товчоор орно. Муушигийн өдөр тутмын тэмцээнтэй ижил дүрэмтэй:

- Өдөр бүр Улаанбаатарын **21:00**-д эхэлнэ. Бүртгэл **20:50**-д хаагдаж, ширээ
  хуваарилагдана; тоглогчид ширээндээ орж хүлээнэ, 21:00 хүртэл хөзөр тарахгүй.
- Бүртгүүлсэн бүх хүнийг санамсаргүйгээр **2–4 хүнтэй** ширээнд аль болох тэнцүү
  хуваарилна (5 → 3+2, 7 → 4+3, 9 → 3+3+3). Ширээ бүр **20 оноо** хүртэл тоглоно.
- Ширээ бүрээс нэг ялагч гарна. Бүх ширээ дуусахаас өмнө дараагийн шат эхлэхгүй;
  шат хооронд 30 секунд. Ганц ширээ үлдвэл тэр нь финал, ялагч нь аварга.
- Эхлэх цагаас **1 минутын** дотор ширээндээ ороогүй хүн хасагдана, бот нөхөхгүй.
  Цагтаа ганцаараа ирсэн бол шууд шалгарна; **хоцорч** ганцаараа ирвэл шалгарахгүй,
  ширээ ялагчгүй хаагдана. Тоглолтын дундаас гарсан хүн fold болно.
- **Хэн ч ирээгүй ширээ** 1 минут + 30 секундын дараа ялагчгүй хаагдана, дараагийн
  шат түүнийг 50 минут хүлээхгүй.
- 2-оос цөөн хүн бүртгүүлбэл цуцлагдана.

**How it works without a server.** 13 has no backend of its own, so unlike
Muushig the tournament is not run by one. These records live in
`Usion.cloud.shared`:

```
t13.v1.<startsAt>.reg        {v, list:[{id, n, a}]}           registrations
t13.v1.<startsAt>.s<N>        {v, t:{<table>: {w, at}}}        each table's winner in stage N
t13.v1.<startsAt>.l<N>        {v, t:{<table>: {s, o, r, at}}}  live scores in stage N
t13.v1.<startsAt>.r<N>        {v, t:{<table>: roomId}}         each table's platform room
t13.v1.fame                   {v, events, list, latest}        champions: wins + the latest
```

Everything else — every stage's seating, who plays whom, when the next stage
starts — is *derived* (`tourDerive()`) from those records plus a seed made from the
event id, so every client computes the identical bracket. Each table is a real
platform room running the normal frozen-roster match. **The relay admits only a
room that exists, and only its players** (backend `handle_game_join`:
`ROOM_NOT_FOUND` / `NOT_PARTICIPANT`), and a room id cannot be chosen — so the
first player at a table creates one (`POST {apiUrl}/games/rooms` with the iframe
token), publishes the id in `.r<N>`, and the others join it over REST
(`POST /games/rooms/{id}/join`) before `game:join` (`tourTableRoom()`). Two
players creating at once converge on the published one before the deal
(`tourCheckRoom()`); a failed join says so instead of bouncing silently. The first
tournament build named rooms itself and seated nobody in production; the test
relay now enforces the same rules (`World({ strictRooms: true })`). Its
opening deal is accepted only from somebody on that table's list, seating only
people on it (`tourOpeningDealOk()`). Every client at the table files the winner
(read-modify-write, then re-read; a write lost in a race is re-filed on the next
poll). A table nobody reports for 50 minutes closes without a winner so a stage
can never hang.

- **No bots at a table (hardening, 2026-11-18).** A player reported meeting a bot
  in the 2026-11-17 event. The database says otherwise: every tournament room's
  saved state seated only humans (`open:false`); the only bot seats that evening
  were solo «Онлайн» tables outside the tournament. Still, a test showed an
  open-table client *could* run inside a tournament room if «Онлайн» fell back to
  it, so: the open-table fallback is only a `standalone_` room (in production
  that means none, and a failed world join plays locally); a tournament table
  refuses any open/bot/off-list seating, live or replayed; and tournament deals
  and checkpoints carry `tour`, which sends a stray open-table client back out.
- **Empty tables and late arrivals (2026-11-18).** The 2026-11-17 event had 102
  registrations and 26 first-stage tables: 13 had nobody, 11 had one person. The
  empty ones were closed only by the 50-minute stall, so stage 2 started at 21:50.
  Now the first arrival's published room (`.r<N>`) is the proof somebody came: once
  the grace minute + 30 s is over, any client looking at the event files each
  table with no room as `{w: null, at: startAt + 1 min}` (`tourCloseEmptyTables`),
  so every client derives the same next-stage time. A table at play re-adds its
  room if a crossed write dropped it (`tourCheckRoom`). And a walkover needs an
  on-time arrival: somebody who sits down alone after the grace minute closes the
  table without a winner (one player arrived 18 minutes late and went through).
  Still open: a table whose players all sat down early and then *left* before the
  start keeps its room, so it still waits for the stall.
- **Capacity.** Built for up to ~200 entrants: one 64 KB record of `{id, n, a}`
  rows (avatar urls over 200 chars are dropped) holds them, 50 tables of four.
- **Polling.** Usion allows 60 shared-storage ops a minute per user. The screen
  refreshes every 10 s and reads only what can still change: registrations until
  20 s after the draw, unfinished stages, and the live scores of the stage in
  play. At a table it polls every 30 s, only to re-file a lost result. Tests hold
  both cases to ≤ 30 ops a minute.
- **Invitation.** Opening the app while registration is open and you are not
  registered shows «Өнөөдөр тэмцээнтэй! Оролцох уу?» (`showTourInvite()`):
  «ОРОЛЦОЁ» registers and opens the tournament, «Үгүй» leaves the home page and
  is remembered for that event. Not shown to chat invites or after 20:50.
- **Coming back.** Opening the app with a live table (or a drawn table you have
  not reached yet) goes straight to it (`tourResumeOnLaunch()`), and the tournament
  screen auto-enters it (`tourMaybeAutoEnter()`) — except a table you left on
  purpose or have already finished.
- **Watching.** The table's lead client publishes totals after each round (at most
  every 4 s); the bracket shows each live table's points out of 20, who is out,
  and the round. **«Ширээ үзэх»** on any other live table opens that table in
  spectator mode, like Muushig: the real game table — opponents, the trick in the
  middle, the turn ring — with the bottom seat's hand face down, «‹ Гарах» top-left and an eye badge with
  the viewer count top-right. The relay can't carry a watcher (a full table's room refuses a fifth
  member: "Game room is full"), so the table's lead client also posts a small
  snapshot to `t13.v1.<startsAt>.w<stage>.<table>` (set only, ≤ every 2 s, only
  on change; removed a minute after the match) and the watcher polls it every
  2 s and draws it with the game's own renderers, putting the real state back
  after each draw — a couple of seconds behind, writes nothing. A watcher still
  in the event is sent back to the bracket the moment their own next table is
  drawn. Each new play flies in from the seat that made it.
- **Viewers.** Each watcher stamps its id into `t13.v1.<startsAt>.v<stage>.<table>`
  (`{v, ids:{<id>: at}}`) every 20 s and takes it out on «Гарах»; stamps older
  than 45 s don't count. The watcher sees an eye badge with the number (top-right), and the players at the
  table read the same record every 15 s and see an eye badge with the number.
  Budget: a watcher ≈ 30 snapshot reads + 6 stamp ops + 6 bracket reads a
  minute; a player adds 4 reads.
- **Champions.** Any client that sees an event finish counts it once in
  `t13.v1.fame` (the champion's own client adds their avatar). The tournament
  screen lists the top 10 and shows 🏆 counts next to registered players.

Limits to know about: `shared.*` is writable by every user of the app, so a
modified client could forge a registration or a result — same trust model as the
rest of 13; real stakes would need a server. The bucket's 200-key cap is why
events older than three days are pruned.

**Daily reminder (20:40).** The game itself cannot notify anyone at 20:40:
`Usion.notify` reaches only the current user and only while the app runs. Usion's
platform daily reminder does it with no server of ours:

1. *Once, by the owner:* add [daily-reminder.json](daily-reminder.json) to the 13
   service (`PUT /services/<service-id>` with the creator token, never from game
   code). 12:40 UTC = 20:40 Ulaanbaatar; tapping it opens `/tournament`.
2. *Each player:* after registering, the tournament screen offers «Өдөр бүр
   20:40-д тэмцээний сануулга авах уу? Асаах / Дараа». «Асаах» asks Usion's
   notification permission on that tap and subscribes only if granted
   (`PUT {apiUrl}/services/{serviceId}/reminders/daily {enabled:true}` with the
   live iframe token); «Дараа» saves `enabled:false`. Afterwards a one-line switch
   turns it off or on again. The card stays hidden until the service is
   configured (`configured:false`).

The reminder repeats every day until the player turns it off, so it reaches
yesterday's registrants too — its text is neutral («Өдрийн тэмцээн 21:00-д
эхэлнэ!»). The service must be published and public.

**The prize is recognition.** The champion gets a 1200×630 banner drawn on a
canvas (`tourChampionBanner()`) and a «Мэдээнд хуваалцах» button that calls
`Usion.shareToFeed` with the banner as the card image and a link back to
`/tournament/<startsAt>`. It posts to the champion's own feed, and the host asks
them to confirm every time; the button only appears when `Usion.canShareToFeed()`.
Everybody else sees the latest champion on the menu (from `t13.v1.fame`, shown
for three days).

QA: `?tourStart=<ISO or epoch ms>` moves today's event, e.g. a few minutes ahead.
Screens: [output/tournament-shots/overview.png](output/tournament-shots/overview.png).

## Game rules (short)

- 13 cards each. First to empty their hand wins the round; everyone else gains
  penalty points for the cards they are left holding (n ≤ 9 → n, 10–12 → 2n,
  13 → 3n). Reach the lose-at threshold and you're eliminated; last survivor wins.
- Single-card strength high→low: `2 A K Q J 10 9 8 7 6 5 4 3`; suits `♠ > ♥ > ♣ > ♦`.
- Combos: single, pair, triple, four, and 5-card hands
  (straight < flush < full house < four+1 < straight flush). Follow with a
  bigger combo of the SAME size, or pass. Being dealt all 13 ranks = instant win ("dragon").

## Why this is a reference implementation

### 1. Deterministic engine + turn log

Online play never ships card data around. One stored
`deal` action carries a **PRNG seed** (`mulberry32`) plus the seat order; every
client deals identical hands locally and applies the same **sequenced move log**
(`Usion.game.action("move", …)`). Any client can rebuild the entire round from
`(seed, moves)` — which is exactly what reconnect recovery does, and exactly what
lets a newcomer take over a bot's half-played hand the instant they walk in.

In an open room the seat order carries `null` for every seat a bot holds, and
**seat changes are moves too** (`seat_take` / `seat_release`), so they live in the
same sequenced log as every card played. The roster is therefore replayable:
rebuilding `(seed, moves)` reconstructs not just the board but who was sitting
where, when. (A chat-invite match has no such actions — its roster is frozen at
Start, and `applySeatMove` refuses them outright.)

Which mode a room runs is **not** something a client decides for itself. It is
set by the launch, then carried on the `deal` action and every checkpoint
(`open: true|false`), so a client can never end up applying one mode's rules to
the other mode's table.

### 2. The multiplayer contract, implemented

| Contract requirement | Where |
|---|---|
| `connect()` → register handlers → `join(config.roomId)` | `setupMultiplayer()` / `registerNetHandlers()` |
| `playerIds[0]` is the host/authority | `isHostPlayer()` presses Start / opens the table at seat 0; every other authority job is rank-staggered |
| Handlers registered up front, even on a `'single'` launch | `Usion.game.onRoomAssigned` registered in `Usion.init` |
| Solo → host promotion (host Share button) | `onRoomPromoted()` — tears the open table down and opens the invite waiting room |
| Trust `mode`, never infer multiplayer from `roomId` | `launchedSolo()` (a solo launch may still get a `standalone_` room) |
| `action()` for turn-based moves, `realtime()` for ephemera | moves/deals/seat changes vs `player_info`/`state_push` |
| Winner decided by shared state, not self-reported | scores derive from the shared log; a bot champion files no result card |
| `onDisconnect` → real pause | `netPaused` freezes the turn clock so a dropped player can't be auto-passed |
| `onPlayerLeft` → settle the seat, with grace | 20 s `startForfeitGrace()` — a quick rejoin resumes the hand untouched; otherwise the seat folds (invite) or goes to a bot (open) |
| `onPlayerJoined` → seat the newcomer | open rooms only: `reconcileOpenSeats()` writes a `seat_take` for the lowest-scoring bot |

### 3. Your own move does not wait for the relay

The deterministic log means a move is only real once the relay has sequenced it.
Applied literally that costs **a full round trip on every tap**: your card sits in
your hand, the Play button stays dead, and the turn does not move until the echo
comes back. Over a phone connection that is the whole feel of the game.

So a move you *own* — your own play or pass, and a bot seat you are the elected
relay for — is applied to your board the instant it is sent
(`applyOptimisticMove`). This is not a prediction: the move was built and
validated with the exact rules every other client will apply to it, and the same
engine produces the same result everywhere. The echo is then matched on
`(ti, cards)` and skipped — while still counting as applied, so the sequence
bookkeeping keeps no holes.

The safety rails around it:

- **Nothing is snapshotted early.** `writeCheckpoint()` and `broadcastStatePush()`
  both bail while a move is in flight, so no other client can be told to replay a
  move the relay may never have stored.
- **A send that fails marks us stale** and asks for a catch-up, because our board
  may now be a move ahead of the room's.
- **An echo that never arrives** (6 s) does the same, and a checkpoint at our own
  sequence is then accepted as the correction.

A cover for *another* human's stalled seat is deliberately excluded: that one
really is a guess about somebody else, so it waits for the relay.

### 4. Reconnect recovery: checkpoint + replay tail

- Whoever **just acted** persists a checkpoint with `Usion.game.setState()`
  (`currentCheckpoint()`): seed, seat order, this round's moves, round-start
  totals, and the sequence it includes. Actor-written (not host-only) so the
  snapshot stays fresh even while the host is backgrounded.
- A (re)joining client gets the checkpoint as `game_state` (join ack / `onSync`)
  → `applyCheckpoint()` re-deals the same seed and replays the tail of actions
  **past the checkpoint's own sequence** (the server's action replay is
  inclusive — skipping `seq <= checkpoint.seq` avoids double-applied moves).
- Every applied action is deduped by `sequence` (`appliedSequences`), and moves
  are anchored to the **sender's seat**, so the turn pointer self-corrects
  instead of drifting after a missed packet.
- Foreground catch-up: RN WebViews fire no `visibilitychange`, so a 1 s
  wall-clock heartbeat detects the frozen-JS gap and pumps
  `requestSync(lastSeq)` until the sequence advances (`beginResync()`).
- As a second recovery path the host **pushes** the current checkpoint over the
  room broadcast when someone (re)joins (`broadcastStatePush`).

### 5. Rematch and auto-restart (platform mode)

Platform mode has **no server-side restart event** — `Usion.game.requestRematch()`
is a pure broadcast to the other players. So: a non-host's PLAY AGAIN sends the
request (peers see who asked via `onRematchRequest`); the **host's** PLAY AGAIN
broadcasts a normal stored `deal` action with `reset: true`, which every client
applies in `onDeal` by zeroing match state before dealing — deterministic and
replay-safe.

An **open room** also restarts on its own: `scheduleOpenRestart()` fires the same
reset deal `OPEN_RESTART_MS` after the champion screen (rank-staggered), so nobody
has to press anything for the room to keep going. PLAY AGAIN just brings it
forward. A chat-invite match does not — it ends when it ends.

### 6a. The waiting room (chat invite)

While invited players trickle into `config.roomId`, the game shows who's present
with a ready toggle; the host locks the final seat order into the `deal` action so
every client (and every reconnect) derives identical seating. The lobby never
creates rooms or draws invite/share UI — the platform owns invites (host Share
button / `Usion.game.invite()`).

### 6b. The open room (no invite)

There is no waiting room and nothing to press. `maybeStart()` schedules
`scheduleOpenStart()`, which deals a 4-seat round `OPEN_START_MS` after the room
settles — `null` in the order for every seat nobody is sitting in. A launch with
no room at all, or a room the relay cannot reach, falls back to the same table
played purely locally, so the zero-tap GameTok contract still holds.

**Bots play online.** A bot seat is driven by `botDecision(seat)`, a pure function
of replayable state (that seat's hand, the table, `firstPlay`). The lowest-seated
human present broadcasts it as an ordinary stored move tagged `bot: true`, and
every client **recomputes the same decision and rejects anything that differs** —
so relaying a bot can never smuggle in a chosen discard. This is the proxy-cover
rule from finding 2, widened from "a forced minimal move" to "the engine's full
choice".

**Joining** (`reconcileOpenSeats` → `seat_take`): the target is
`takeoverSeat()` — the non-eliminated bot seat with the **lowest total**, lowest
seat index breaking a tie. Every client recomputes that target when the action
lands, so a claim naming any other seat is rejected identically everywhere. The
seat's `total`, `out` and `hands[seat]` are left completely untouched; only who
controls it changes.

**Leaving** (`sendSeatRelease` → `seat_release`): after the 20 s grace, the seat
goes back to a bot with its score intact. Nothing writes `leave_fold` /
`forfeit_win` any more — an open table never folds a seat out of the match — though
`applyRemoteMove` still accepts and validates both so an older client's log
replays.

**Coming back to a seat that is gone.** A released player never applies their own
release (`applySeatMove` refuses to evict the seat you are sitting in), so on
return they still believe they hold it. If the room's state is genuinely *ahead*
of everything they have applied and does not name them, `becomeUnseated()` drops
them back to the waiting state and `reconcileOpenSeats` deals them in again. See
finding 4 in [test/README.md](test/README.md) — arguing with the room here is a
split table that never heals.

**No single point of failure.** Seat claims are rank-staggered exactly like
`scheduleNextDeal`: the lowest present seat writes first, every other seated
client covers `SEAT_STAGGER_MS` later. A locked phone never leaves `presentIds`,
so a single elected writer asleep would otherwise lock newcomers out of the room
forever — the same trap as finding 1.

### 7. GameTok / Explore

A `'single'` launch (Explore or the GameTok feed) drops straight into a zero-tap
round vs 3 bots — no menu, per the GameTok contract. What changed is that it is
now an **open room on a shared public table**: the same three bots, except every
move is a stored action and anyone else who taps Play lands at the same table and
takes a bot's seat. With no room to join (self-hosted preview) or a relay it
cannot reach, it degrades to the identical table played locally rather than
stranding the player on a menu.

The same build registers all multiplayer handlers up front, so the Share button
can promote the room mid-session: `onRoomPromoted()` tears the open table down
and opens the invite waiting room in the new room.

### 8. Platform capabilities used

- `Usion.cloud` — cross-device win/loss stats (localStorage fallback), plus a
  shared `games_total` counter via atomic `shared.incr`.
- `Usion.leaderboard.submit` — cumulative wins.
- i18n: every UI string lives in the `STR` table (mn/en), chosen via
  `Usion.getLanguage()` (navigator fallback outside the host).

## Run it locally

```bash
npx @usions/devkit dev path/to/13     # or: usion dev .
# Player 1: http://localhost:4747/
# Player 2: http://localhost:4747/?player=2
```

Launched without an invite, both tabs find the same public table: player 1 is
dealt in against 3 bots straight away, and player 2 takes over the lowest-scoring
bot mid-round. Launched from a chat invite, both tabs land in the waiting room and
wait for READY + Start.

The devkit fake host serves the game with real platform semantics (rooms,
sequenced actions, checkpoints) and a chaos panel — blip the connection and
watch the pause/resync, or drop a player and watch the 20 s grace expire into a
fold (invite) or a bot takeover (open room).

Note: the platform injects `https://usions.com/usion-sdk.js`; the script tag in
`index.html` exists so the game also runs self-hosted/standalone.

## Tests

```bash
node 13/test/run_all.cjs
```

206 headless scenario tests covering both modes and the tournament, no dependencies and no browser:
every simulated player is the real `script.js` in its own `vm` realm on a virtual
clock. See [test/README.md](test/README.md).

## License

[MIT](LICENSE)
