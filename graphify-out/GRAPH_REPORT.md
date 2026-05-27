# Graph Report - BCUK-Bot-4  (2026-05-27)

## Corpus Check
- 153 files · ~75,404 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1148 nodes · 2572 edges · 75 communities (70 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `4b7bfa67`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]

## God Nodes (most connected - your core abstractions)
1. `getPool()` - 67 edges
2. `createLogger()` - 53 edges
3. `normalizeTwitchChannelName()` - 18 edges
4. `csrfProtection()` - 18 edges
5. `main()` - 16 edges
6. `getDiscordClient()` - 16 edges
7. `What You Must Do When Invoked` - 16 edges
8. `recordCommandTestEntry()` - 15 edges
9. `getUsers()` - 15 edges
10. `getStreams()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `triggerRestart()` --calls--> `restartTwitchMonitor()`  [EXTRACTED]
  src/web/routes/streams.ts → src/twitchMonitor.ts
- `requireStreamer()` --calls--> `getStreamerByDiscordId()`  [EXTRACTED]
  src/web/routes/overlayAdmin.ts → src/db/eventSub.ts
- `renderLiveRows()` --calls--> `makeCell()`  [INFERRED]
  public/streams-live-table.js → public/streams-utils.js
- `handleDisconnected()` --calls--> `isStale()`  [INFERRED]
  src/audioConnectionHandlers.ts → src/twitchEventSub.ts
- `connectToChannel()` --calls--> `handleCommand()`  [EXTRACTED]
  src/tiktokBot.ts → src/commandRouter.ts

## Communities (75 total, 5 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.08
Nodes (60): clearStreamerLive(), DbStreamerFull, DbStreamGroup, setStreamerLive(), getDiscordClient(), getAvailableVoiceChannels(), isDiscordNotFoundError(), isPermanentVoiceMisconfigurationError() (+52 more)

### Community 1 - "Community 1"
Cohesion: 0.07
Nodes (47): archiveAndResetYearlyCounters(), closePool(), handleDisconnected(), TIKTOK_CHANNELS, log, msUntilNextJan1(), startCounterScheduler(), stopCounterScheduler() (+39 more)

### Community 2 - "Community 2"
Cohesion: 0.04
Nodes (49): code:bash ($(cat graphify-out/.graphify_python) -c "), code:block11 ([Agent tool call 1: files 1-15, subagent_type="general-purpo), code:bash (PROJECT_ROOT=$(cat graphify-out/.graphify_root)), code:block13 (You are a graphify extraction subagent. Read the files liste), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+41 more)

### Community 3 - "Community 3"
Cohesion: 0.04
Nodes (45): dependencies, discord.js, @discordjs/voice, dotenv, ejs, express, express-mysql-session, express-rate-limit (+37 more)

### Community 4 - "Community 4"
Cohesion: 0.09
Nodes (38): EventSubConfig, base, clients, connections, filePath, keepalive, key, log (+30 more)

### Community 5 - "Community 5"
Cohesion: 0.05
Nodes (38): code:block1 (/graphify                                             # full), code:bash (if [ ! -f graphify-out/.graphify_python ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash (if [ ! -f graphify-out/.graphify_extract.json ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+30 more)

### Community 6 - "Community 6"
Cohesion: 0.07
Nodes (32): getAllEventSubStreamers(), addStreamer(), addStreamGroup(), AddStreamGroupInput, DbStreamer, getAllStreamers(), getAllStreamersWithGroups(), getAllStreamGroups() (+24 more)

### Community 7 - "Community 7"
Cohesion: 0.08
Nodes (30): buildCustomCommandLookupCache(), CustomCommandLookupCache, customCommandLookupCacheState, getCustomCommandForTwitchChannel(), getTwitchCommandCacheKey(), log, normalizeActiveTwitchChannels(), pickPreferredTwitchCandidate() (+22 more)

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (30): invalidateCustomCommandLookupCache(), removeCustomCommand(), unassignUserFromCommand(), initEventConfig(), saveEventConfig(), addVideo(), deleteReward(), deleteVideo() (+22 more)

### Community 9 - "Community 9"
Cohesion: 0.13
Nodes (21): createDiscordEmbed(), createEmbedFields(), createEmbedImage(), createEmbedTitle(), createMessageContent(), createMessagePreview(), createDetailRow(), createMultiTwitchSection() (+13 more)

### Community 10 - "Community 10"
Cohesion: 0.20
Nodes (23): findUser(), findUserByTwitchName(), getTwitchEnabledChannels(), mapUser(), addOrUpdateUserMutation(), handleChangeTwitchChannel(), handleClearTwitchChannel(), log (+15 more)

### Community 11 - "Community 11"
Cohesion: 0.14
Nodes (20): cleanupFailedConnect(), ConnectionHandlerDeps, log, releasePreviousConnection(), setupConnectionHandlers(), buildAdapter(), clearReconnectTimer(), connect() (+12 more)

### Community 12 - "Community 12"
Cohesion: 0.16
Nodes (23): assertDiscordTriggerAvailable(), assertMultiTwitchTriggerAvailable(), assertNoSingleTwitchAssignmentOverlap(), assertNoTwitchChannelTriggerConflict(), assignUserToCommandWithinTransaction(), getCommandTriggerStringById(), getUserTwitchEligibility(), hasMultiTwitchTriggerConflict() (+15 more)

### Community 13 - "Community 13"
Cohesion: 0.14
Nodes (22): clearStreamerToken(), saveStreamerToken(), { code, state, error }, expectedLogin, log, router, fetchTwitchRewards(), authHeaders() (+14 more)

### Community 14 - "Community 14"
Cohesion: 0.17
Nodes (21): dispatchShoutout(), executeShoutoutForTwitch(), formatShoutoutMessage(), log, resolveShoutoutData(), ShoutoutRuntime, mockRuntime, chunks() (+13 more)

### Community 15 - "Community 15"
Cohesion: 0.16
Nodes (17): acquireNamedLocks(), buildCounterExistsCheckPlan(), buildCustomCommandExistsCheckPlan(), executeExistsCheck(), getSortedCommandLockNames(), isAnyCommandTakenAcrossTables(), isCustomCommandTriggerTaken(), log (+9 more)

### Community 16 - "Community 16"
Cohesion: 0.09
Nodes (21): code:sql (SHOW VARIABLES LIKE 'character_set_%';), code:sql (CREATE DATABASE your_database), code:sql (ALTER DATABASE your_database), code:sql (ALTER TABLE example_table), code:sql (CREATE INDEX idx_cc_trigger ON custom_command(trigger_string), code:sql (ALTER TABLE custom_command), code:sql (ALTER TABLE counter), `counter` (+13 more)

### Community 17 - "Community 17"
Cohesion: 0.13
Nodes (17): _COOLDOWN, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER, DISCORD_CALLBACK_URL, SESSION_SECRET, TWITCH_CLIENT_ID (+9 more)

### Community 18 - "Community 18"
Cohesion: 0.10
Nodes (18): DbUser, assignableUsers, { command_id }, { command_id, discord_id }, { command_id, trigger_string, output }, commandsForView, CommandViewModel, discordIds (+10 more)

### Community 19 - "Community 19"
Cohesion: 0.20
Nodes (18): runSerializedCommandWrite(), requireTrimmedString(), invalidateCounterLookupCache(), addCounter(), ARCHIVE_YEAR_COLUMNS, counterExists(), getCounterCommandsById(), mapCounter() (+10 more)

### Community 20 - "Community 20"
Cohesion: 0.15
Nodes (17): getCustomCommandForDiscord(), CommandTestEntry, CommandTestSource, entries, recordCommandTestEntry(), executeCustomCommandForDiscord(), executeCustomCommandForTwitch(), inFlightRefreshes (+9 more)

### Community 21 - "Community 21"
Cohesion: 0.15
Nodes (18): DbStreamerEventSub, DEFAULT_EVENT_CONFIG, getStreamerByDiscordId(), getStreamerById(), mapBool(), mapConfig(), mapStreamerEventSub(), maybeDecrypt() (+10 more)

### Community 22 - "Community 22"
Cohesion: 0.17
Nodes (15): findSoundFiles(), isPlaying(), handleCommand(), log, errorSpy, FILES, first, firstTriggerPromise (+7 more)

### Community 23 - "Community 23"
Cohesion: 0.11
Nodes (16): AccessLevel, { discord_id }, { discord_id, access_level }, { discord_id, discord_name, access_level, twitch_name, clear_twitch_name }, { discord_id, is_twitch_bot_enabled }, KNOWN_ERRORS, level, log (+8 more)

### Community 24 - "Community 24"
Cohesion: 0.18
Nodes (15): findCounterByCommand(), incrementCounter(), _buildCounterResponse(), CounterResult, executeCounterCommandForDiscord(), executeCounterCommandForTwitch(), formatCounterMessage(), log (+7 more)

### Community 25 - "Community 25"
Cohesion: 0.13
Nodes (15): { channelId }, { command }, discordClient, filename, fullPath, log, normalizedCommand, router (+7 more)

### Community 26 - "Community 26"
Cohesion: 0.12
Nodes (13): body, dir, filePath, fullPath, log, requireStreamer(), rewardId, router (+5 more)

### Community 27 - "Community 27"
Cohesion: 0.12
Nodes (15): compilerOptions, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir, skipLibCheck (+7 more)

### Community 28 - "Community 28"
Cohesion: 0.24
Nodes (14): applyStatus(), applyVoiceChannelData(), body, channelSelect, clearChildren(), fetchStatus(), loadVoiceChannels(), rejoinBtn (+6 more)

### Community 29 - "Community 29"
Cohesion: 0.17
Nodes (12): log, recentEntries, router, log, router, status, getRecentCommandTestEntries(), getStatus() (+4 more)

### Community 30 - "Community 30"
Cohesion: 0.18
Nodes (11): CounterNotFoundError, CounterFormValidationResult, form, { id }, KNOWN_ERRORS, log, normalizeRequiredText(), normalizeSingleTokenRequiredText() (+3 more)

### Community 31 - "Community 31"
Cohesion: 0.19
Nodes (12): findTrigger(), getAllSfxTriggers(), getPublicSfxTriggers(), mapBool(), PublicSfxTrigger, SfxFile, SfxTrigger, SfxTriggerRow (+4 more)

### Community 32 - "Community 32"
Cohesion: 0.23
Nodes (9): extractCommand(), CountdownTwitchRuntime, executeCountdownForTwitch(), log, registerCountdownTwitchRuntime(), sleep(), STEPS, mockRuntime (+1 more)

### Community 33 - "Community 33"
Cohesion: 0.23
Nodes (11): createMutationQueue(), setTwitchChannel(), activeChannels, activeChannelUserIds, getActiveChannelUserIds(), isChannelJoined(), joinMissingChannel(), log (+3 more)

### Community 34 - "Community 34"
Cohesion: 0.15
Nodes (10): body, config, ERROR_MESSAGES, expectedAccount, KNOWN_ERRORS, log, messageFields, params (+2 more)

### Community 35 - "Community 35"
Cohesion: 0.17
Nodes (11): Access Levels, ALWAYS: Before Committing, ALWAYS: Use Graphify — Never Grep or Read to Explore, BCUK Bot 4 — Claude Code Instructions, code:bash (graphify query "where is X defined"           # replaces: gr), code:bash (npx tsc --noEmit && npm test), code:bash (npm run dev   # ts-node src/index.ts), Critical Invariants (+3 more)

### Community 36 - "Community 36"
Cohesion: 0.27
Nodes (10): broadcastToActiveChannels(), resolveSharedChatSessionId(), broadcastToGroupChannels(), executeMultiCommandForTwitch(), log, MultiTwitchRuntime, registerMultiTwitchRuntime(), mockRuntime (+2 more)

### Community 37 - "Community 37"
Cohesion: 0.17
Nodes (11): { access_token }, { code, state }, log, params, profile, router, state, trimmedDisplayName (+3 more)

### Community 38 - "Community 38"
Cohesion: 0.20
Nodes (8): CounterLookupCache, counterLookupCacheState, isCounterCommandTaken(), log, CounterMatchType, DbCounter, DbMatchedCounter, getAllCounters()

### Community 39 - "Community 39"
Cohesion: 0.27
Nodes (10): ACCESS_LEVEL_LABELS, getAllUsers(), log, removeUserRecord(), setTwitchBotEnabledRecord(), updateAccessLevel(), updateDiscordName(), upsertUserRecord() (+2 more)

### Community 40 - "Community 40"
Cohesion: 0.18
Nodes (10): background_color, description, display, icons, id, name, scope, short_name (+2 more)

### Community 41 - "Community 41"
Cohesion: 0.20
Nodes (5): isRuntimeCachePath(), shouldUseRuntimeCache(), STATIC_ASSETS, swr, url

### Community 42 - "Community 42"
Cohesion: 0.27
Nodes (10): activateSort(), applyFilter(), applySort(), cmdCount, getRows(), headers, noResults, searchInput (+2 more)

### Community 43 - "Community 43"
Cohesion: 0.33
Nodes (8): isConnected(), startPlayback(), getRealSfxRoot(), isPathInsideRoot(), log, playFile(), sfxRoot, VoiceNotConnectedError

### Community 44 - "Community 44"
Cohesion: 0.25
Nodes (9): log, RefreshOutcome, refreshState, router, ensureSessionCsrfToken(), requireAdmin(), requireManager(), requireMod() (+1 more)

### Community 45 - "Community 45"
Cohesion: 0.22
Nodes (7): cmdCount, noResults, q, rows, searchInput, sfxTable, toggleBtn

### Community 46 - "Community 46"
Cohesion: 0.22
Nodes (7): inflight, op1, op2, opA, order, { promise: gate, resolve: openGate }, queue

### Community 47 - "Community 47"
Cohesion: 0.22
Nodes (7): batch1, batch2, logins, promise, session, stream, TOKEN_RESPONSE

### Community 48 - "Community 48"
Cohesion: 0.25
Nodes (7): { channelId }, discordClient, log, router, getCurrentChannelId(), DISCORD_VOICE_CHANNEL_ID, requireAuth()

### Community 49 - "Community 49"
Cohesion: 0.29
Nodes (5): ADMIN_KNOWN_ERRORS, log, router, validId, WEB_PORT

### Community 50 - "Community 50"
Cohesion: 0.29
Nodes (5): log, router, consoleFormat, fileFormat, sharedTransports

### Community 51 - "Community 51"
Cohesion: 0.33
Nodes (5): hooks, PreToolUse, SessionStart, permissions, allow

### Community 52 - "Community 52"
Cohesion: 0.33
Nodes (4): BUILT_IN_COMMANDS, BuiltInCommandMeta, RESERVED_BUILT_IN_COMMANDS, ReservedCommandError

### Community 53 - "Community 53"
Cohesion: 0.47
Nodes (3): fetchRecentEntries(), formatWhen(), renderEntries()

### Community 54 - "Community 54"
Cohesion: 0.40
Nodes (4): BCUK Bot 4, code:bash (npm install), Requirements, Usage

### Community 55 - "Community 55"
Cohesion: 0.40
Nodes (4): log, router, streamerId, reloadEventSubSubscriptions()

### Community 56 - "Community 56"
Cohesion: 0.50
Nodes (4): DbCustomCommandAssignedUser, AccessLevelValue, AddOrUpdateParams, ChangeTwitchChannelParams

### Community 57 - "Community 57"
Cohesion: 0.50
Nodes (3): include_patterns, pages, repo_notes

### Community 58 - "Community 58"
Cohesion: 0.67
Nodes (3): connect(), playNext(), queue

### Community 60 - "Community 60"
Cohesion: 0.50
Nodes (3): Request, SessionData, SessionUser

## Knowledge Gaps
- **453 isolated node(s):** `name`, `version`, `description`, `dev`, `build` (+448 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createLogger()` connect `Community 31` to `Community 0`, `Community 1`, `Community 4`, `Community 6`, `Community 7`, `Community 10`, `Community 11`, `Community 12`, `Community 13`, `Community 14`, `Community 15`, `Community 17`, `Community 18`, `Community 20`, `Community 21`, `Community 22`, `Community 23`, `Community 24`, `Community 25`, `Community 26`, `Community 29`, `Community 30`, `Community 32`, `Community 33`, `Community 34`, `Community 36`, `Community 37`, `Community 38`, `Community 39`, `Community 43`, `Community 44`, `Community 48`, `Community 49`, `Community 50`, `Community 55`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._
- **Why does `getPool()` connect `Community 8` to `Community 0`, `Community 1`, `Community 38`, `Community 6`, `Community 39`, `Community 10`, `Community 12`, `Community 13`, `Community 15`, `Community 17`, `Community 19`, `Community 21`, `Community 22`, `Community 24`, `Community 31`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **Why does `VoiceNotConnectedError` connect `Community 43` to `Community 25`, `Community 22`?**
  _High betweenness centrality (0.008) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _453 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.08169014084507042 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.06711915535444947 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.04081632653061224 - nodes in this community are weakly interconnected._