# Graph Report - .  (2026-05-27)

## Corpus Check
- 146 files · ~75,002 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 774 nodes · 2130 edges · 30 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Discord & Stream Status|Discord & Stream Status]]
- [[_COMMUNITY_User & Access Control|User & Access Control]]
- [[_COMMUNITY_Command & Counter DB Layer|Command & Counter DB Layer]]
- [[_COMMUNITY_Counter Cache & Lookup|Counter Cache & Lookup]]
- [[_COMMUNITY_Twitch EventSub Handlers|Twitch EventSub Handlers]]
- [[_COMMUNITY_Command Validation & Locking|Command Validation & Locking]]
- [[_COMMUNITY_Twitch OAuth & API|Twitch OAuth & API]]
- [[_COMMUNITY_Configuration & Environment|Configuration & Environment]]
- [[_COMMUNITY_Stream Group Management|Stream Group Management]]
- [[_COMMUNITY_Custom Command Assignments|Custom Command Assignments]]
- [[_COMMUNITY_Custom Command Cache & Routing|Custom Command Cache & Routing]]
- [[_COMMUNITY_Stream Group API Routes|Stream Group API Routes]]
- [[_COMMUNITY_Voice Connection Lifecycle|Voice Connection Lifecycle]]
- [[_COMMUNITY_EventSub WebSocket Connection|EventSub WebSocket Connection]]
- [[_COMMUNITY_Streamdeck API Key Management|Streamdeck API Key Management]]
- [[_COMMUNITY_Twitch Command Assignment Rules|Twitch Command Assignment Rules]]
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

## God Nodes (most connected - your core abstractions)
1. `getPool()` - 66 edges
2. `createLogger()` - 54 edges
3. `normalizeTwitchChannelName()` - 18 edges
4. `csrfProtection()` - 18 edges
5. `discordClient` - 18 edges
6. `getStreams()` - 16 edges
7. `runSerializedCommandWrite()` - 15 edges
8. `connect()` - 14 edges
9. `main()` - 13 edges
10. `getUsers()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `handleDisconnected()` --calls--> `isStale()`  [INFERRED]
  src/audioConnectionHandlers.ts → src/twitchEventSub.ts
- `broadcastToActiveChannels()` --calls--> `getActiveChannels()`  [INFERRED]
  src/customCommandHandler.ts → src/twitchBot.ts
- `triggerRestart()` --calls--> `startTwitchMonitor()`  [EXTRACTED]
  src/web/routes/streams.ts → src/twitchMonitor.ts
- `requireStreamer()` --calls--> `getStreamerById()`  [EXTRACTED]
  src/web/routes/overlayAdmin.ts → src/db/eventSub.ts
- `connectToChannel()` --calls--> `handleCommand()`  [EXTRACTED]
  src/tiktokBot.ts → src/commandRouter.ts

## Communities (30 total, 0 thin omitted)

### Community 0 - "Discord & Stream Status"
Cohesion: 0.05
Nodes (97): getAllCounters(), invalidateCustomCommandLookupCache(), DbCustomCommandAssignedUser, invalidateCustomCommandLookupCache(), removeCustomCommand(), unassignUserFromCommand(), clearStreamerToken(), DbStreamerEventSub (+89 more)

### Community 1 - "User & Access Control"
Cohesion: 0.07
Nodes (71): clearStreamerLive(), DbStreamerFull, DbStreamGroup, setStreamerLive(), discordClient, getAvailableVoiceChannels(), isDiscordNotFoundError(), log (+63 more)

### Community 2 - "Command & Counter DB Layer"
Cohesion: 0.05
Nodes (61): buildCounterExistsCheckPlan(), buildCustomCommandExistsCheckPlan(), executeExistsCheck(), getSortedCommandLockNames(), isAnyCommandTakenAcrossTables(), isCustomCommandTriggerTaken(), log, runSerializedCommandWrite() (+53 more)

### Community 3 - "Counter Cache & Lookup"
Cohesion: 0.05
Nodes (62): assertDiscordTriggerAvailable(), assertMultiTwitchTriggerAvailable(), assertNoSingleTwitchAssignmentOverlap(), assertNoTwitchChannelTriggerConflict(), assignUserToCommandWithinTransaction(), getCommandTriggerStringById(), getUserTwitchEligibility(), hasMultiTwitchTriggerConflict() (+54 more)

### Community 4 - "Twitch EventSub Handlers"
Cohesion: 0.06
Nodes (57): EventSubConfig, { code, state }, expectedLogin, log, router, pushOverlayEvent(), authHeaders(), createEventSubSubscription() (+49 more)

### Community 5 - "Command Validation & Locking"
Cohesion: 0.05
Nodes (34): body, dir, fetchTwitchRewards(), filePath, fullPath, log, requireStreamer(), rewardId (+26 more)

### Community 6 - "Twitch OAuth & API"
Cohesion: 0.09
Nodes (25): { access_token }, log, params, profile, router, state, trimmedDisplayName, userData (+17 more)

### Community 7 - "Configuration & Environment"
Cohesion: 0.16
Nodes (20): cleanupFailedConnect(), ConnectionHandlerDeps, handleDisconnected(), log, releasePreviousConnection(), setupConnectionHandlers(), buildAdapter(), clearReconnectTimer() (+12 more)

### Community 8 - "Stream Group Management"
Cohesion: 0.13
Nodes (19): findSoundFiles(), findTrigger(), getAllSfxTriggers(), mapBool(), SfxFile, SfxTrigger, SfxTriggerRow, isPlaying() (+11 more)

### Community 9 - "Custom Command Assignments"
Cohesion: 0.17
Nodes (20): closePool(), registerCounterTwitchRuntime(), log, msUntilNextJan1(), startCounterScheduler(), stopCounterScheduler(), tick(), registerTwitchChatRuntime() (+12 more)

### Community 10 - "Custom Command Cache & Routing"
Cohesion: 0.12
Nodes (18): { channelId }, log, router, log, router, status, getCurrentChannelId(), DISCORD_GUILD_ID (+10 more)

### Community 11 - "Stream Group API Routes"
Cohesion: 0.10
Nodes (18): DbCustomCommandWithAssignments, DbUser, assignableUsers, { command_id }, { command_id, discord_id }, { command_id, trigger_string, output }, commandsForView, CommandViewModel (+10 more)

### Community 12 - "Voice Connection Lifecycle"
Cohesion: 0.17
Nodes (16): log, RefreshOutcome, refreshState, router, log, recentEntries, router, createCsrfError() (+8 more)

### Community 13 - "EventSub WebSocket Connection"
Cohesion: 0.15
Nodes (12): log, router, streamerId, log, router, log, parseKey(), consoleFormat (+4 more)

### Community 14 - "Streamdeck API Key Management"
Cohesion: 0.12
Nodes (14): ACCESS_LEVEL_LABELS, { discord_id }, { discord_id, access_level }, { discord_id, discord_name, access_level, twitch_name, clear_twitch_name }, { discord_id, is_twitch_bot_enabled }, KNOWN_ERRORS, level, log (+6 more)

### Community 15 - "Twitch Command Assignment Rules"
Cohesion: 0.19
Nodes (13): getCustomCommandForDiscord(), getCustomCommandForTwitchChannel(), getCustomCommandForDiscord(), getCustomCommandForTwitchChannel(), broadcastToActiveChannels(), executeCustomCommandForTwitch(), inFlightRefreshes, log (+5 more)

### Community 16 - "SFX Command Handling"
Cohesion: 0.21
Nodes (11): CommandTestEntry, CommandTestSource, entries, getRecentCommandTestEntries(), recordCommandTestEntry(), dispatchShoutout(), executeShoutoutForTwitch(), formatShoutoutMessage() (+3 more)

### Community 17 - "SFX File & EventSub Admin"
Cohesion: 0.22
Nodes (12): TWITCH_OAUTH_TOKEN, TWITCH_USERNAME, setTwitchChannel(), activeChannels, activeChannelUserIds, getActiveChannelUserIds(), isChannelJoined(), joinMissingChannel() (+4 more)

### Community 18 - "Overlay Reward Management"
Cohesion: 0.15
Nodes (10): body, config, ERROR_MESSAGES, expectedAccount, KNOWN_ERRORS, log, messageFields, params (+2 more)

### Community 19 - "Admin Panel Routes"
Cohesion: 0.20
Nodes (8): createMutationQueue(), inflight, op1, op2, opA, order, { promise: gate, resolve: openGate }, queue

### Community 20 - "Streamer Configuration"
Cohesion: 0.18
Nodes (10): base, clients, connections, filePath, keepalive, key, log, RESERVED_LOGINS (+2 more)

### Community 21 - "Counter API Routes"
Cohesion: 0.33
Nodes (8): isConnected(), startPlayback(), getRealSfxRoot(), isPathInsideRoot(), log, playFile(), sfxRoot, VoiceNotConnectedError

### Community 22 - "CSRF & EventSub Admin Routes"
Cohesion: 0.22
Nodes (10): TIKTOK_CHANNELS, setTikTokChannel(), updateChannel(), activeConnections, Connection, connectToChannel(), log, pendingReconnectTimers (+2 more)

### Community 23 - "Request Validation & Error Messages"
Cohesion: 0.33
Nodes (8): findCounterByCommand(), findCounterByCommand(), _buildCounterResponse(), CounterResult, executeCounterCommandForTwitch(), formatCounterMessage(), log, TwitchSendRuntime

### Community 24 - "SFX Trigger Cache & Public API"
Cohesion: 0.22
Nodes (8): { channelId }, { command }, discordClient, filename, fullPath, log, router, requireApiKey()

### Community 25 - "Discord OAuth Authentication"
Cohesion: 0.36
Nodes (6): extractCommand(), CountdownTwitchRuntime, executeCountdownForTwitch(), log, sleep(), STEPS

### Community 26 - "Async Cache System"
Cohesion: 0.38
Nodes (6): resolveSharedChatSessionId(), broadcastToGroupChannels(), executeMultiCommandForTwitch(), log, MultiTwitchRuntime, getActiveChannels()

### Community 27 - "SFX Playback Engine"
Cohesion: 0.40
Nodes (5): getPublicSfxTriggers(), PublicSfxTrigger, getCachedData(), log, router

### Community 28 - "TikTok Bot Integration"
Cohesion: 0.50
Nodes (3): Request, SessionData, SessionUser

## Knowledge Gaps
- **253 isolated node(s):** `log`, `log`, `Connection`, `TikTokModules`, `activeConnections` (+248 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `createLogger()` connect `EventSub WebSocket Connection` to `Discord & Stream Status`, `User & Access Control`, `Command & Counter DB Layer`, `Counter Cache & Lookup`, `Twitch EventSub Handlers`, `Command Validation & Locking`, `Twitch OAuth & API`, `Configuration & Environment`, `Stream Group Management`, `Custom Command Assignments`, `Custom Command Cache & Routing`, `Stream Group API Routes`, `Voice Connection Lifecycle`, `Streamdeck API Key Management`, `Twitch Command Assignment Rules`, `SFX Command Handling`, `SFX File & EventSub Admin`, `Overlay Reward Management`, `Streamer Configuration`, `Counter API Routes`, `CSRF & EventSub Admin Routes`, `Request Validation & Error Messages`, `SFX Trigger Cache & Public API`, `Discord OAuth Authentication`, `Async Cache System`, `SFX Playback Engine`?**
  _High betweenness centrality (0.177) - this node is a cross-community bridge._
- **Why does `getPool()` connect `Discord & Stream Status` to `User & Access Control`, `Command & Counter DB Layer`, `Counter Cache & Lookup`, `Twitch OAuth & API`, `Stream Group Management`, `Custom Command Assignments`, `SFX Playback Engine`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `createMutationQueue()` connect `Admin Panel Routes` to `SFX File & EventSub Admin`, `Streamdeck API Key Management`?**
  _High betweenness centrality (0.012) - this node is a cross-community bridge._
- **What connects `log`, `log`, `Connection` to the rest of the system?**
  _253 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Discord & Stream Status` be split into smaller, more focused modules?**
  _Cohesion score 0.05013477088948787 - nodes in this community are weakly interconnected._
- **Should `User & Access Control` be split into smaller, more focused modules?**
  _Cohesion score 0.07376543209876543 - nodes in this community are weakly interconnected._
- **Should `Command & Counter DB Layer` be split into smaller, more focused modules?**
  _Cohesion score 0.05368421052631579 - nodes in this community are weakly interconnected._