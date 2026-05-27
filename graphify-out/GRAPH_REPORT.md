# Graph Report - .  (2026-05-27)

## Corpus Check
- Corpus is ~35,703 words - fits in a single context window. You may not need a graph.

## Summary
- 772 nodes · 2099 edges · 37 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Discord & Status Management|Discord & Status Management]]
- [[_COMMUNITY_User & Access Control|User & Access Control]]
- [[_COMMUNITY_Command & Counter Database Layer|Command & Counter Database Layer]]
- [[_COMMUNITY_Counter System|Counter System]]
- [[_COMMUNITY_Twitch EventSub Handlers|Twitch EventSub Handlers]]
- [[_COMMUNITY_Command Validation & Locking|Command Validation & Locking]]
- [[_COMMUNITY_Twitch OAuth & API|Twitch OAuth & API]]
- [[_COMMUNITY_Configuration & Environment|Configuration & Environment]]
- [[_COMMUNITY_Stream Group Management|Stream Group Management]]
- [[_COMMUNITY_Custom Command Assignments|Custom Command Assignments]]
- [[_COMMUNITY_Custom Command Cache & Routing|Custom Command Cache & Routing]]
- [[_COMMUNITY_Stream Group API Routes|Stream Group API Routes]]
- [[_COMMUNITY_Discord Guild & Channel Routing|Discord Guild & Channel Routing]]
- [[_COMMUNITY_EventSub WebSocket Connection|EventSub WebSocket Connection]]
- [[_COMMUNITY_Streamdeck API Key Management|Streamdeck API Key Management]]
- [[_COMMUNITY_Twitch Command Assignment Rules|Twitch Command Assignment Rules]]
- [[_COMMUNITY_Voice Connection Lifecycle|Voice Connection Lifecycle]]
- [[_COMMUNITY_SFX Command Handling|SFX Command Handling]]
- [[_COMMUNITY_SFX File & EventSub Admin|SFX File & EventSub Admin]]
- [[_COMMUNITY_Overlay Reward Management|Overlay Reward Management]]
- [[_COMMUNITY_Admin Panel Routes|Admin Panel Routes]]
- [[_COMMUNITY_Streamer Configuration|Streamer Configuration]]
- [[_COMMUNITY_Counter API Routes|Counter API Routes]]
- [[_COMMUNITY_CSRF & EventSub Admin Routes|CSRF & EventSub Admin Routes]]
- [[_COMMUNITY_Request Validation & Error Messages|Request Validation & Error Messages]]
- [[_COMMUNITY_SFX Trigger Cache & Public API|SFX Trigger Cache & Public API]]
- [[_COMMUNITY_Discord OAuth Authentication|Discord OAuth Authentication]]
- [[_COMMUNITY_Async Cache System|Async Cache System]]
- [[_COMMUNITY_SFX Playback Engine|SFX Playback Engine]]
- [[_COMMUNITY_TikTok Bot Integration|TikTok Bot Integration]]
- [[_COMMUNITY_WebSocket Server|WebSocket Server]]
- [[_COMMUNITY_Streamdeck Integration Routes|Streamdeck Integration Routes]]
- [[_COMMUNITY_Logging & Audio Handlers|Logging & Audio Handlers]]
- [[_COMMUNITY_Counter & Command CRUD|Counter & Command CRUD]]
- [[_COMMUNITY_Built-in Command Registry|Built-in Command Registry]]
- [[_COMMUNITY_EventSub Subscription Manager|EventSub Subscription Manager]]
- [[_COMMUNITY_Express Session Types|Express Session Types]]

## God Nodes (most connected - your core abstractions)
1. `getPool()` - 67 edges
2. `createLogger()` - 53 edges
3. `csrfProtection()` - 18 edges
4. `getDiscordClient()` - 16 edges
5. `normalizeTwitchChannelName()` - 15 edges
6. `runSerializedCommandWrite()` - 15 edges
7. `main()` - 14 edges
8. `findUser()` - 14 edges
9. `connect()` - 13 edges
10. `getUsers()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `triggerRestart()` --calls--> `restartTwitchMonitor()`  [EXTRACTED]
  src/web/routes/streams.ts → src/twitchMonitor.ts
- `handleDisconnected()` --calls--> `isStale()`  [INFERRED]
  src/audioConnectionHandlers.ts → src/twitchEventSub.ts
- `connectToChannel()` --calls--> `handleCommand()`  [EXTRACTED]
  src/tiktokBot.ts → src/commandRouter.ts
- `main()` --calls--> `startTikTokBot()`  [EXTRACTED]
  src/index.ts → src/tiktokBot.ts
- `stopTikTokBot()` --calls--> `setTikTokChannel()`  [EXTRACTED]
  src/tiktokBot.ts → src/statusStore.ts

## Communities (37 total, 0 thin omitted)

### Community 0 - "Discord & Status Management"
Cohesion: 0.08
Nodes (69): clearStreamerLive(), DbStreamerFull, setStreamerLive(), getDiscordClient(), getAvailableVoiceChannels(), isDiscordNotFoundError(), log, tryDeleteDiscordMessage() (+61 more)

### Community 1 - "User & Access Control"
Cohesion: 0.06
Nodes (66): DbCustomCommandAssignedUser, ACCESS_LEVEL_LABELS, AccessLevelValue, findUser(), findUserByTwitchName(), getTwitchEnabledChannels(), log, mapUser() (+58 more)

### Community 2 - "Command & Counter Database Layer"
Cohesion: 0.05
Nodes (65): findCounterByCommand(), getCustomCommandForTwitchChannel(), closePool(), CommandTestEntry, CommandTestSource, entries, getRecentCommandTestEntries(), recordCommandTestEntry() (+57 more)

### Community 3 - "Counter System"
Cohesion: 0.09
Nodes (26): ARCHIVE_YEAR_COLUMNS, archiveAndResetYearlyCounters(), counterExists(), CounterLookupCache, counterLookupCacheState, CounterMatchType, CounterNotFoundError, DbCounter (+18 more)

### Community 4 - "Twitch EventSub Handlers"
Cohesion: 0.16
Nodes (24): EventSubConfig, pushOverlayEvent(), sayInChannel(), fill(), FollowEvent, GiftSubEvent, handleFollow(), handleGiftSub() (+16 more)

### Community 5 - "Command Validation & Locking"
Cohesion: 0.15
Nodes (20): acquireNamedLocks(), buildCounterExistsCheckPlan(), buildCustomCommandExistsCheckPlan(), commandExists(), executeExistsCheck(), getSortedCommandLockNames(), isAnyCommandTakenAcrossTables(), isCustomCommandTriggerTaken() (+12 more)

### Community 6 - "Twitch OAuth & API"
Cohesion: 0.15
Nodes (21): clearStreamerToken(), saveStreamerToken(), { code, state, error }, expectedLogin, log, router, authHeaders(), getCustomRewards() (+13 more)

### Community 7 - "Configuration & Environment"
Cohesion: 0.12
Nodes (19): _COOLDOWN, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER, DISCORD_CLIENT_ID, DISCORD_TOKEN, DISCORD_VOICE_CHANNEL_ID (+11 more)

### Community 8 - "Stream Group Management"
Cohesion: 0.14
Nodes (22): initEventConfig(), saveEventConfig(), getPool(), addStreamer(), addStreamGroup(), AddStreamGroupInput, DbStreamer, DbStreamGroup (+14 more)

### Community 9 - "Custom Command Assignments"
Cohesion: 0.10
Nodes (19): DbCustomCommandWithAssignments, DbUser, assignableUsers, { command_id }, { command_id, discord_id }, { command_id, trigger_string, output }, commandsForView, CommandViewModel (+11 more)

### Community 10 - "Custom Command Cache & Routing"
Cohesion: 0.15
Nodes (19): assertDiscordTriggerAvailable(), buildCustomCommandLookupCache(), CustomCommandLookupCache, customCommandLookupCacheState, DbCustomCommand, getAllCustomCommandsWithAssignments(), getCustomCommandForDiscord(), getTwitchCommandCacheKey() (+11 more)

### Community 11 - "Stream Group API Routes"
Cohesion: 0.10
Nodes (17): parsePositiveIntId(), { discord_id, group_id }, eligibleUsers, ERROR_MESSAGES, eventSubById, existingStreamerIds, { group_id }, { group_id, name, discord_channel, live_message, new_game_message } (+9 more)

### Community 12 - "Discord Guild & Channel Routing"
Cohesion: 0.13
Nodes (16): { channelId }, discordClient, log, router, log, router, status, getCurrentChannelId() (+8 more)

### Community 13 - "EventSub WebSocket Connection"
Cohesion: 0.16
Nodes (18): handleDisconnected(), buildReconnectUrl(), clearKeepaliveTimer(), connect(), disconnectNoSubscriptions(), EventSubMessage, EventSubMetadata, handleMessage() (+10 more)

### Community 14 - "Streamdeck API Key Management"
Cohesion: 0.16
Nodes (16): approveApiKey(), denyApiKey(), findApprovedKeyByHash(), getAllApiKeys(), getApiKeyStatus(), getPendingRequests(), mapRow(), requestApiKey() (+8 more)

### Community 15 - "Twitch Command Assignment Rules"
Cohesion: 0.20
Nodes (17): assertMultiTwitchTriggerAvailable(), assertNoSingleTwitchAssignmentOverlap(), assertNoTwitchChannelTriggerConflict(), assignUserToCommandWithinTransaction(), getCommandTriggerStringById(), getUserTwitchEligibility(), hasMultiTwitchTriggerConflict(), hasSingleTwitchAssignmentOverlap() (+9 more)

### Community 16 - "Voice Connection Lifecycle"
Cohesion: 0.22
Nodes (16): cleanupFailedConnect(), releasePreviousConnection(), setupConnectionHandlers(), clearReconnectTimer(), connect(), disconnect(), getPlayer(), log (+8 more)

### Community 17 - "SFX Command Handling"
Cohesion: 0.20
Nodes (14): findSoundFiles(), findTrigger(), isPlaying(), handleCommand(), log, errorSpy, FILES, first (+6 more)

### Community 18 - "SFX File & EventSub Admin"
Cohesion: 0.12
Nodes (14): DbStreamerEventSub, body, dir, fetchTwitchRewards(), filePath, fullPath, log, rewardId (+6 more)

### Community 19 - "Overlay Reward Management"
Cohesion: 0.24
Nodes (14): addVideo(), deleteReward(), deleteVideo(), getRewardsForStreamer(), getVideoById(), getVideosForReward(), getVideosForStreamer(), mapVideo() (+6 more)

### Community 20 - "Admin Panel Routes"
Cohesion: 0.18
Nodes (12): log, RefreshOutcome, refreshState, router, log, recentEntries, router, ensureSessionCsrfToken() (+4 more)

### Community 21 - "Streamer Configuration"
Cohesion: 0.25
Nodes (12): DEFAULT_EVENT_CONFIG, getStreamerByDiscordId(), getStreamerById(), mapBool(), mapConfig(), mapStreamerEventSub(), maybeDecrypt(), requireStreamer() (+4 more)

### Community 22 - "Counter API Routes"
Cohesion: 0.19
Nodes (11): CounterFormValidationResult, form, { id }, KNOWN_ERRORS, log, normalizeRequiredText(), normalizeSingleTokenRequiredText(), parsedId (+3 more)

### Community 23 - "CSRF & EventSub Admin Routes"
Cohesion: 0.21
Nodes (10): log, router, streamerId, log, router, reloadEventSubSubscriptions(), createCsrfError(), csrfProtection() (+2 more)

### Community 24 - "Request Validation & Error Messages"
Cohesion: 0.15
Nodes (10): body, config, ERROR_MESSAGES, expectedAccount, KNOWN_ERRORS, log, messageFields, params (+2 more)

### Community 25 - "SFX Trigger Cache & Public API"
Cohesion: 0.21
Nodes (10): getAllSfxTriggers(), getPublicSfxTriggers(), mapBool(), PublicSfxTrigger, SfxFile, SfxTrigger, SfxTriggerRow, getCachedData() (+2 more)

### Community 26 - "Discord OAuth Authentication"
Cohesion: 0.17
Nodes (11): { access_token }, { code, state }, log, params, profile, router, state, trimmedDisplayName (+3 more)

### Community 27 - "Async Cache System"
Cohesion: 0.18
Nodes (9): BASE_OPTS, createEmptyCache, freshResult, { getCache }, { getCache, invalidate }, loadCache, pending, staleResult (+1 more)

### Community 28 - "SFX Playback Engine"
Cohesion: 0.33
Nodes (8): isConnected(), startPlayback(), getRealSfxRoot(), isPathInsideRoot(), log, playFile(), sfxRoot, VoiceNotConnectedError

### Community 29 - "TikTok Bot Integration"
Cohesion: 0.22
Nodes (10): TIKTOK_CHANNELS, setTikTokChannel(), updateChannel(), activeConnections, Connection, connectToChannel(), log, pendingReconnectTimers (+2 more)

### Community 30 - "WebSocket Server"
Cohesion: 0.18
Nodes (10): base, clients, connections, filePath, keepalive, key, log, RESERVED_LOGINS (+2 more)

### Community 31 - "Streamdeck Integration Routes"
Cohesion: 0.20
Nodes (9): { channelId }, { command }, discordClient, filename, fullPath, log, normalizedCommand, router (+1 more)

### Community 32 - "Logging & Audio Handlers"
Cohesion: 0.25
Nodes (6): ConnectionHandlerDeps, log, consoleFormat, createLogger(), fileFormat, sharedTransports

### Community 33 - "Counter & Command CRUD"
Cohesion: 0.31
Nodes (9): requireTrimmedString(), addCounter(), normalizeCounterFields(), addCustomCommand(), invalidateCustomCommandLookupCache(), removeCustomCommand(), unassignUserFromCommand(), updateCustomCommand() (+1 more)

### Community 34 - "Built-in Command Registry"
Cohesion: 0.33
Nodes (4): BUILT_IN_COMMANDS, BuiltInCommandMeta, RESERVED_BUILT_IN_COMMANDS, ReservedCommandError

### Community 35 - "EventSub Subscription Manager"
Cohesion: 0.40
Nodes (5): getAllEventSubStreamers(), createSubscriptionsForStreamer(), resolveBroadcasterId(), subscribe(), subscribeAll()

### Community 36 - "Express Session Types"
Cohesion: 0.50
Nodes (3): Request, SessionData, SessionUser

## Knowledge Gaps
- **255 isolated node(s):** `log`, `log`, `Connection`, `TikTokModules`, `activeConnections` (+250 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createLogger()` connect `Logging & Audio Handlers` to `Discord & Status Management`, `User & Access Control`, `Command & Counter Database Layer`, `Counter System`, `Twitch EventSub Handlers`, `Command Validation & Locking`, `Twitch OAuth & API`, `Configuration & Environment`, `Custom Command Assignments`, `Custom Command Cache & Routing`, `Stream Group API Routes`, `Discord Guild & Channel Routing`, `EventSub WebSocket Connection`, `Streamdeck API Key Management`, `Twitch Command Assignment Rules`, `Voice Connection Lifecycle`, `SFX Command Handling`, `SFX File & EventSub Admin`, `Admin Panel Routes`, `Streamer Configuration`, `Counter API Routes`, `CSRF & EventSub Admin Routes`, `Request Validation & Error Messages`, `SFX Trigger Cache & Public API`, `Discord OAuth Authentication`, `SFX Playback Engine`, `TikTok Bot Integration`, `WebSocket Server`, `Streamdeck Integration Routes`?**
  _High betweenness centrality (0.174) - this node is a cross-community bridge._
- **Why does `getPool()` connect `Stream Group Management` to `Discord & Status Management`, `User & Access Control`, `Command & Counter Database Layer`, `Counter System`, `EventSub Subscription Manager`, `Command Validation & Locking`, `Twitch OAuth & API`, `Configuration & Environment`, `Counter & Command CRUD`, `Custom Command Cache & Routing`, `Streamdeck API Key Management`, `Twitch Command Assignment Rules`, `SFX Command Handling`, `Overlay Reward Management`, `Streamer Configuration`, `SFX Trigger Cache & Public API`?**
  _High betweenness centrality (0.023) - this node is a cross-community bridge._
- **What connects `log`, `log`, `Connection` to the rest of the system?**
  _255 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Discord & Status Management` be split into smaller, more focused modules?**
  _Cohesion score 0.07562479714378449 - nodes in this community are weakly interconnected._
- **Should `User & Access Control` be split into smaller, more focused modules?**
  _Cohesion score 0.05754385964912281 - nodes in this community are weakly interconnected._
- **Should `Command & Counter Database Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._
- **Should `Counter System` be split into smaller, more focused modules?**
  _Cohesion score 0.08669354838709678 - nodes in this community are weakly interconnected._