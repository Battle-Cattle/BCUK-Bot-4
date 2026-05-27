# Graph Report - .  (2026-05-27)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 1171 nodes · 2731 edges · 69 communities (64 shown, 5 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `3bd56d9d`
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
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
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
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]

## God Nodes (most connected - your core abstractions)
1. `getPool()` - 67 edges
2. `createLogger()` - 55 edges
3. `normalizeTwitchChannelName()` - 21 edges
4. `getStreams()` - 18 edges
5. `csrfProtection()` - 18 edges
6. `discordClient` - 18 edges
7. `runSerializedCommandWrite()` - 18 edges
8. `main()` - 16 edges
9. `isDiscordNotFoundError()` - 16 edges
10. `getDiscordClient()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `broadcastToActiveChannels()` --calls--> `getActiveChannels()`  [INFERRED]
  src/customCommandHandler.ts → src/twitchBot.ts
- `csrfErrorHandler()` --calls--> `ensureSessionCsrfToken()`  [EXTRACTED]
  src/web/server.ts → src/web/csrf.ts
- `renderLiveRows()` --calls--> `makeCell()`  [INFERRED]
  public/streams-live-table.js → public/streams-utils.js
- `handleDisconnected()` --calls--> `isStale()`  [INFERRED]
  src/audioConnectionHandlers.ts → src/twitchEventSub.ts
- `main()` --calls--> `startTikTokBot()`  [EXTRACTED]
  src/index.ts → src/tiktokBot.ts

## Communities (69 total, 5 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.12
Nodes (28): dispatchShoutout(), executeShoutoutForTwitch(), formatShoutoutMessage(), log, resolveShoutoutData(), ShoutoutRuntime, mockRuntime, chunks() (+20 more)

### Community 1 - "Community 1"
Cohesion: 0.08
Nodes (62): clearStreamerLive(), DbStreamerFull, DbStreamGroup, setStreamerLive(), discordClient, triggerRestart(), getDiscordClient(), getAvailableVoiceChannels() (+54 more)

### Community 2 - "Community 2"
Cohesion: 0.13
Nodes (21): invalidateCounterLookupCache(), addCounter(), ARCHIVE_YEAR_COLUMNS, archiveAndResetYearlyCounters(), counterExists(), CounterLookupCache, counterLookupCacheState, CounterNotFoundError (+13 more)

### Community 3 - "Community 3"
Cohesion: 0.18
Nodes (17): commandExists(), buildCustomCommandLookupCache(), CustomCommandLookupCache, getAllCustomCommandsWithAssignments(), getCustomCommandForTwitchChannel(), getTwitchCommandCacheKey(), log, mapBool() (+9 more)

### Community 4 - "Community 4"
Cohesion: 0.16
Nodes (24): EventSubConfig, pushOverlayEvent(), sayInChannel(), fill(), FollowEvent, GiftSubEvent, handleFollow(), handleGiftSub() (+16 more)

### Community 5 - "Community 5"
Cohesion: 0.11
Nodes (15): { discord_id, group_id }, eligibleUsers, ERROR_MESSAGES, eventSubById, existingStreamerIds, { group_id }, { group_id, name, discord_channel, live_message, new_game_message }, KNOWN_ERRORS (+7 more)

### Community 6 - "Community 6"
Cohesion: 0.13
Nodes (17): _COOLDOWN, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER, DISCORD_CALLBACK_URL, SESSION_SECRET, TWITCH_OAUTH_TOKEN (+9 more)

### Community 7 - "Community 7"
Cohesion: 0.05
Nodes (68): findSoundFiles(), findTrigger(), getAllSfxTriggers(), mapBool(), SfxFile, SfxTrigger, SfxTriggerRow, { channelId } (+60 more)

### Community 8 - "Community 8"
Cohesion: 0.14
Nodes (19): handleDisconnected(), TwitchAuthError, buildReconnectUrl(), clearKeepaliveTimer(), connect(), disconnectNoSubscriptions(), EventSubMessage, EventSubMetadata (+11 more)

### Community 9 - "Community 9"
Cohesion: 0.17
Nodes (19): closePool(), log, msUntilNextJan1(), startCounterScheduler(), stopCounterScheduler(), tick(), startDiscordBot(), stopDiscordBot() (+11 more)

### Community 10 - "Community 10"
Cohesion: 0.04
Nodes (49): code:bash ($(cat graphify-out/.graphify_python) -c "), code:block11 ([Agent tool call 1: files 1-15, subagent_type="general-purpo), code:bash (PROJECT_ROOT=$(cat graphify-out/.graphify_root)), code:block13 (You are a graphify extraction subagent. Read the files liste), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+41 more)

### Community 11 - "Community 11"
Cohesion: 0.09
Nodes (28): requireTrimmedString(), CustomCommandLookupCache, invalidateCustomCommandLookupCache(), TwitchCommandCandidate, addCustomCommand(), DbCustomCommand, removeCustomCommand(), unassignUserFromCommand() (+20 more)

### Community 12 - "Community 12"
Cohesion: 0.20
Nodes (12): getAllUsers(), updateDiscordName(), log, RefreshOutcome, router, runDiscordNameRefresh(), DISCORD_GUILD_ID, DISCORD_TOKEN (+4 more)

### Community 13 - "Community 13"
Cohesion: 0.13
Nodes (19): log, recentEntries, router, log, router, streamerId, ADMIN_KNOWN_ERRORS, log (+11 more)

### Community 14 - "Community 14"
Cohesion: 0.22
Nodes (15): fetchTwitchRewards(), TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, authHeaders(), getCustomRewards(), twitchFetch(), createEventSubSubscription(), deleteEventSubSubscription() (+7 more)

### Community 15 - "Community 15"
Cohesion: 0.16
Nodes (15): getCustomCommandForDiscord(), getCustomCommandForDiscord(), broadcastToActiveChannels(), executeCustomCommandForDiscord(), executeCustomCommandForTwitch(), inFlightRefreshes, log, lookupCommand() (+7 more)

### Community 16 - "Community 16"
Cohesion: 0.29
Nodes (6): { channelId }, log, router, getCurrentChannelId(), DISCORD_VOICE_CHANNEL_ID, requireAuth()

### Community 17 - "Community 17"
Cohesion: 0.29
Nodes (6): { code, state }, { code, state, error }, expectedLogin, log, router, reloadEventSubSubscriptions()

### Community 18 - "Community 18"
Cohesion: 0.15
Nodes (10): body, config, ERROR_MESSAGES, expectedAccount, KNOWN_ERRORS, log, messageFields, params (+2 more)

### Community 19 - "Community 19"
Cohesion: 0.53
Nodes (6): getAllEventSubStreamers(), getValidToken(), createSubscriptionsForStreamer(), resolveBroadcasterId(), subscribe(), subscribeAll()

### Community 20 - "Community 20"
Cohesion: 0.18
Nodes (10): base, clients, connections, filePath, keepalive, key, log, RESERVED_LOGINS (+2 more)

### Community 21 - "Community 21"
Cohesion: 0.33
Nodes (4): BUILT_IN_COMMANDS, BuiltInCommandMeta, RESERVED_BUILT_IN_COMMANDS, ReservedCommandError

### Community 22 - "Community 22"
Cohesion: 0.18
Nodes (10): log, router, status, log, router, consoleFormat, createLogger(), fileFormat (+2 more)

### Community 23 - "Community 23"
Cohesion: 0.15
Nodes (18): findCounterByCommand(), findCounterByCommand(), CommandTestEntry, CommandTestSource, entries, recordCommandTestEntry(), _buildCounterResponse(), CounterResult (+10 more)

### Community 25 - "Community 25"
Cohesion: 0.21
Nodes (10): extractCommand(), CountdownTwitchRuntime, executeCountdownForTwitch(), log, registerCountdownTwitchRuntime(), sleep(), STEPS, mockRuntime (+2 more)

### Community 26 - "Community 26"
Cohesion: 0.29
Nodes (9): resolveSharedChatSessionId(), broadcastToGroupChannels(), executeMultiCommandForTwitch(), log, MultiTwitchRuntime, registerMultiTwitchRuntime(), mockRuntime, getActiveChannels() (+1 more)

### Community 27 - "Community 27"
Cohesion: 0.40
Nodes (5): getPublicSfxTriggers(), PublicSfxTrigger, getCachedData(), log, router

### Community 28 - "Community 28"
Cohesion: 0.50
Nodes (3): Request, SessionData, SessionUser

### Community 30 - "Community 30"
Cohesion: 0.04
Nodes (45): dependencies, discord.js, @discordjs/voice, dotenv, ejs, express, express-mysql-session, express-rate-limit (+37 more)

### Community 31 - "Community 31"
Cohesion: 0.05
Nodes (38): code:block1 (/graphify                                             # full), code:bash (if [ ! -f graphify-out/.graphify_python ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash (if [ ! -f graphify-out/.graphify_extract.json ]; then), code:bash ($(cat graphify-out/.graphify_python) -c "), code:bash ($(cat graphify-out/.graphify_python) -c ") (+30 more)

### Community 32 - "Community 32"
Cohesion: 0.13
Nodes (21): createDiscordEmbed(), createEmbedFields(), createEmbedImage(), createEmbedTitle(), createMessageContent(), createMessagePreview(), createDetailRow(), createMultiTwitchSection() (+13 more)

### Community 33 - "Community 33"
Cohesion: 0.13
Nodes (22): clearStreamerToken(), DEFAULT_EVENT_CONFIG, getStreamerByDiscordId(), getStreamerById(), initEventConfig(), mapBool(), mapConfig(), mapStreamerEventSub() (+14 more)

### Community 34 - "Community 34"
Cohesion: 0.15
Nodes (22): assertDiscordTriggerAvailable(), assertMultiTwitchTriggerAvailable(), assertNoSingleTwitchAssignmentOverlap(), assertNoTwitchChannelTriggerConflict(), assignUserToCommandWithinTransaction(), getCommandTriggerStringById(), getUserTwitchEligibility(), hasMultiTwitchTriggerConflict() (+14 more)

### Community 35 - "Community 35"
Cohesion: 0.09
Nodes (20): CounterLookupCache, counterLookupCacheState, log, CounterMatchType, DbCounter, DbMatchedCounter, createManagedLookupCache(), log (+12 more)

### Community 36 - "Community 36"
Cohesion: 0.09
Nodes (21): code:sql (SHOW VARIABLES LIKE 'character_set_%';), code:sql (CREATE DATABASE your_database), code:sql (ALTER DATABASE your_database), code:sql (ALTER TABLE example_table), code:sql (CREATE INDEX idx_cc_trigger ON custom_command(trigger_string), code:sql (ALTER TABLE custom_command), code:sql (ALTER TABLE counter), `counter` (+13 more)

### Community 37 - "Community 37"
Cohesion: 0.17
Nodes (18): buildCounterExistsCheckPlan(), buildCustomCommandExistsCheckPlan(), executeExistsCheck(), isAnyCommandTakenAcrossTables(), isCustomCommandTriggerTaken(), log, SqlExistsCheckPlan, buildInClausePlaceholders() (+10 more)

### Community 38 - "Community 38"
Cohesion: 0.21
Nodes (10): CounterFormValidationResult, form, { id }, KNOWN_ERRORS, log, normalizeRequiredText(), normalizeSingleTokenRequiredText(), parsedId (+2 more)

### Community 39 - "Community 39"
Cohesion: 0.12
Nodes (41): addVideo(), deleteReward(), deleteVideo(), getRewardsForStreamer(), getVideoById(), getVideosForReward(), getVideosForStreamer(), mapVideo() (+33 more)

### Community 40 - "Community 40"
Cohesion: 0.23
Nodes (13): buildCustomCommandLookupCache(), customCommandLookupCacheState, getCustomCommandForTwitchChannel(), getTwitchCommandCacheKey(), log, normalizeActiveTwitchChannels(), pickPreferredTwitchCandidate(), registerAssignedTwitchCandidates() (+5 more)

### Community 41 - "Community 41"
Cohesion: 0.06
Nodes (67): DbCustomCommandAssignedUser, ACCESS_LEVEL_LABELS, AccessLevelValue, findUser(), findUserByTwitchName(), getTwitchEnabledChannels(), log, mapUser() (+59 more)

### Community 42 - "Community 42"
Cohesion: 0.12
Nodes (14): DbStreamerEventSub, body, dir, filePath, fullPath, log, rewardId, router (+6 more)

### Community 44 - "Community 44"
Cohesion: 0.12
Nodes (15): compilerOptions, esModuleInterop, module, moduleResolution, outDir, resolveJsonModule, rootDir, skipLibCheck (+7 more)

### Community 45 - "Community 45"
Cohesion: 0.24
Nodes (14): applyStatus(), applyVoiceChannelData(), body, channelSelect, clearChildren(), fetchStatus(), loadVoiceChannels(), rejoinBtn (+6 more)

### Community 46 - "Community 46"
Cohesion: 0.17
Nodes (11): Access Levels, ALWAYS: Before Committing, ALWAYS: Use Graphify — Never Grep or Read to Explore, BCUK Bot 4 — Claude Code Instructions, code:bash (graphify query "where is X defined"           # replaces: gr), code:bash (npx tsc --noEmit && npm test), code:bash (npm run dev   # ts-node src/index.ts), Critical Invariants (+3 more)

### Community 47 - "Community 47"
Cohesion: 0.18
Nodes (10): background_color, description, display, icons, id, name, scope, short_name (+2 more)

### Community 48 - "Community 48"
Cohesion: 0.20
Nodes (5): isRuntimeCachePath(), shouldUseRuntimeCache(), STATIC_ASSETS, swr, url

### Community 49 - "Community 49"
Cohesion: 0.27
Nodes (10): activateSort(), applyFilter(), applySort(), cmdCount, getRows(), headers, noResults, searchInput (+2 more)

### Community 50 - "Community 50"
Cohesion: 0.18
Nodes (10): { access_token }, log, params, profile, router, state, trimmedDisplayName, userData (+2 more)

### Community 52 - "Community 52"
Cohesion: 0.22
Nodes (7): cmdCount, noResults, q, rows, searchInput, sfxTable, toggleBtn

### Community 53 - "Community 53"
Cohesion: 0.33
Nodes (5): hooks, PreToolUse, SessionStart, permissions, allow

### Community 54 - "Community 54"
Cohesion: 0.47
Nodes (3): fetchRecentEntries(), formatWhen(), renderEntries()

### Community 55 - "Community 55"
Cohesion: 0.40
Nodes (4): BCUK Bot 4, code:bash (npm install), Requirements, Usage

### Community 57 - "Community 57"
Cohesion: 0.50
Nodes (3): include_patterns, pages, repo_notes

### Community 58 - "Community 58"
Cohesion: 0.67
Nodes (3): connect(), playNext(), queue

## Knowledge Gaps
- **445 isolated node(s):** `name`, `version`, `description`, `dev`, `build` (+440 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createLogger()` connect `Community 22` to `Community 0`, `Community 1`, `Community 2`, `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 8`, `Community 9`, `Community 11`, `Community 12`, `Community 13`, `Community 14`, `Community 15`, `Community 16`, `Community 17`, `Community 18`, `Community 20`, `Community 23`, `Community 25`, `Community 26`, `Community 27`, `Community 33`, `Community 34`, `Community 35`, `Community 37`, `Community 38`, `Community 40`, `Community 41`, `Community 42`, `Community 50`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Why does `getPool()` connect `Community 39` to `Community 33`, `Community 34`, `Community 3`, `Community 2`, `Community 1`, `Community 37`, `Community 7`, `Community 6`, `Community 41`, `Community 9`, `Community 11`, `Community 12`, `Community 19`, `Community 27`?**
  _High betweenness centrality (0.011) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _445 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.11931818181818182 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.08257229832572298 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.13105413105413105 - nodes in this community are weakly interconnected._
- **Should `Community 5` be split into smaller, more focused modules?**
  _Cohesion score 0.1111111111111111 - nodes in this community are weakly interconnected._