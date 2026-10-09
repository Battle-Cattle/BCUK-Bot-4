# Database Schema

This project targets an existing MySQL 8 database. The application code in this repository assumes the tables below already exist.

Schema changes are managed outside this repository. This file documents the expected database contract for local setup, deployment, and review.

## General Notes

- MySQL version: 8.x
- Character set: `utf8mb4`
- Discord IDs and other snowflake-style IDs should be stored as `BIGINT` in MySQL and treated as strings in application code.
- Boolean-like columns may be returned by `mysql2` as `Buffer` or numeric values depending on server/driver configuration.
- `express-mysql-session` manages the `sessions` table automatically on first run when enabled.

### Verifying and Enforcing `utf8mb4`

Use these statements to verify the current server and database character-set settings:

```sql
SHOW VARIABLES LIKE 'character_set_%';
SELECT @@character_set_database, @@collation_database;
```

When creating a database or table, explicitly set the character set and collation rather than relying on server defaults. For example:

```sql
CREATE DATABASE your_database
    CHARACTER SET = utf8mb4
    COLLATE = utf8mb4_unicode_ci;

CREATE TABLE example_table (
    id INT NOT NULL AUTO_INCREMENT,
    name VARCHAR(255) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

If the database already exists and needs to be aligned with `utf8mb4`, update it explicitly:

```sql
ALTER DATABASE your_database
    CHARACTER SET = utf8mb4
    COLLATE = utf8mb4_unicode_ci;
```

Where needed, existing tables can also be converted individually:

```sql
ALTER TABLE example_table
    CONVERT TO CHARACTER SET utf8mb4
    COLLATE utf8mb4_unicode_ci;
```

## `sfxtrigger`

Stores top-level sound trigger commands.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGINT` PK | Trigger identifier |
| `trigger_command` | `VARCHAR(...)` | Full command string including prefix, e.g. `!clap` |
| `category_id` | `INT` nullable | FK to `sfxcategory.id` |
| `hidden` | `TINYINT(1)` | Listing-only flag; hidden triggers still work |
| `description` | `VARCHAR(...)` nullable | Optional description |

## `sfx`

Stores sound files associated with a trigger.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Sound row identifier |
| `trigger_id` | `BIGINT` | FK to `sfxtrigger.id` |
| `file` | `VARCHAR(...)` | Filename relative to `SFX_FOLDER` |
| `trigger_command` | `VARCHAR(...)` nullable | Legacy column; not used for routing |
| `weight` | `INT` | Weighted-random selection; non-positive values are treated like `1` by the app |
| `hidden` | `TINYINT(1)` | Listing-only flag; hidden files still play |
| `category_id` | `INT` nullable | FK to `sfxcategory.id` |

## `sfxcategory`

Stores SFX categories.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Category identifier |
| `name` | `VARCHAR(...)` | Display name |

## `guild`

Registry of every Discord server the bot serves, plus per-guild configuration. Created by `migrations/multi_guild.sql`. Populated automatically by the `guildCreate` handler when the bot is added to a server.

| Column | Type | Notes |
| --- | --- | --- |
| `guild_id` | `BIGINT` PK | Discord guild (server) ID |
| `name` | `VARCHAR(255)` | Display name, synced from Discord |
| `voice_channel_id` | `BIGINT` nullable | Default voice channel for this guild (replaces the `DISCORD_VOICE_CHANNEL_ID` env var) |
| `created_at` | `TIMESTAMP` | When the guild was registered |

## `guild_member`

Per-guild access levels. Replaces the single global `user.access_level`. A user with no row in a given guild is treated as access level `0` (User). Created by `migrations/multi_guild.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `guild_id` | `BIGINT` | FK to `guild.guild_id` `ON DELETE CASCADE` |
| `discord_id` | `BIGINT` | FK to `user.discord_id` `ON DELETE CASCADE` |
| `access_level` | `INT` | `0=USER`, `1=MOD`, `2=MANAGER`, `3=ADMIN` — scoped to this guild |

Expected constraints:

- Composite primary key `(guild_id, discord_id)`.
- Cross-guild super-admin is expressed by `user.is_owner`, not by a `guild_member` row.

## `user`

Stores web/admin users plus Twitch bot participation state.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` PK | Discord numeric user ID |
| `discord_name` | `VARCHAR(...)` nullable | Last synced display name |
| `is_twitch_bot_enabled` | `BIT(1)` or `TINYINT(1)` | Whether the Twitch bot should join this user's Twitch channel |
| `twitch_name` | `VARCHAR(...)` nullable | Twitch channel name; should be unique when non-null |
| `twitchoauth` | `VARCHAR(...)` nullable | Legacy/optional Twitch auth storage |
| `access_level` | `INT` | `0=USER`, `1=MOD`, `2=MANAGER`, `3=ADMIN`. **Deprecated** — per-guild access lives in `guild_member`; this column is migrated into `guild_member` and dropped in a later migration |
| `is_owner` | `TINYINT(1)` | Global super-admin flag. Set manually in the DB only; never settable through the web panel |

Expected constraints and behavior:

- `twitch_name` should use a case-insensitive collation so uniqueness is enforced without case sensitivity.
- Blank Twitch names should be stored as `NULL`, not empty strings.

## `stream_group`

Stores configuration for Twitch announcement groups.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Group identifier |
| `guild_id` | `BIGINT` | FK to `guild.guild_id`; the server this group belongs to |
| `name` | `VARCHAR(...)` | Display name |
| `discord_channel` | `BIGINT` | Channel ID for announcements (must belong to `guild_id`) |
| `live_message` | `TEXT` | Go-live message template |
| `new_game_message` | `TEXT` | Game-change message template |
| `multi_twitch` | `BIT(1)` or `TINYINT(1)` | Enables multitwitch URL field in embeds |
| `delete_old_posts` | `BIT(1)` or `TINYINT(1)` | Delete old announcement on game change instead of editing |

## `streamer`

Stores monitored Twitch streamers and their current Discord post state. Each row maps a Discord user to a stream announcement group. The Twitch channel name is read from the linked `user` row (`user.twitch_name`) rather than stored redundantly.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Streamer row identifier |
| `discord_id` | `BIGINT` UNIQUE | FK to `user.discord_id`; one row per user |
| `group_id` | `INT` | FK to `stream_group.id` |
| `discord_message_id` | `VARCHAR(20)` nullable | ID of the last announcement message |
| `discord_channel_id` | `BIGINT` nullable | Channel where the last message was posted |
| `live_game` | `VARCHAR(255)` nullable | Last seen live game |
| `twitch_user_id` | `VARCHAR(50)` nullable | Twitch numeric user ID (used for EventSub) |
| `eventsub_access_token` | `TEXT` nullable | AES-256-GCM encrypted Twitch broadcaster OAuth access token |
| `eventsub_refresh_token` | `TEXT` nullable | AES-256-GCM encrypted refresh token |
| `eventsub_token_expiry` | `BIGINT` nullable | Token expiry as Unix milliseconds |

Expected constraints:

- `UNIQUE KEY uq_streamer_discord_id (discord_id)` — enforces one stream group per user.
- `FOREIGN KEY (discord_id) REFERENCES user(discord_id) ON DELETE CASCADE` — removing a user automatically removes their streamer row.
- `FOREIGN KEY (group_id) REFERENCES stream_group(id)` — group must exist.

Apply `migrations/consolidate_streamer_user.sql` to migrate from the previous schema (which stored `name VARCHAR` instead of `discord_id BIGINT`).

## `twitch_bot_chat_token`

Single global row (`id` pinned to 1) holding the refreshing OAuth token for the bot's own Twitch chat account — see issue #550. Distinct from `streamer.eventsub_*` above: those are per-streamer broadcaster tokens used for EventSub, one row per streamer; this is one bot-wide credential for the account the chat bot itself logs in as, so it doesn't fit the per-streamer `streamer` table.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `TINYINT` PK | Always `1` — singleton row |
| `twitch_user_id` | `VARCHAR(50)` nullable | Twitch numeric user ID of the connected bot account |
| `access_token` | `TEXT` nullable | AES-256-GCM encrypted OAuth access token |
| `refresh_token` | `TEXT` nullable | AES-256-GCM encrypted refresh token |
| `token_expiry` | `BIGINT` nullable | Token expiry as Unix milliseconds |
| `connection_id` | `BIGINT` | Increments on every save (initial connect or reconnect, same account or not); used as the compare-and-swap key so a write from a superseded in-process auth provider is dropped instead of clobbering a newer connection — see `src/twitch/twitchBot.ts` |
| `attempt_started_at` | `BIGINT` nullable | Unix milliseconds; when the OAuth connect flow that produced the current row was *initiated* (not when its callback completed). Orders two independently-completing OAuth callbacks so the most recently *started* attempt always wins the row, regardless of which callback's network round trip finishes first — see `saveBotChatTokenIfLatestAttempt()` in `src/db/twitchBotAuth.ts` |

Expected constraints:

- `CONSTRAINT chk_twitch_bot_chat_token_singleton CHECK (id = 1)` — enforces exactly one row.

Created by `migrations/twitch_bot_chat_token.sql`. Connected/reconnected via the owner-only `/admin/bot-auth` web flow, not manually.

## `streamer_event_config`

Per-streamer EventSub notification message configuration. Applied once the streamer has connected their Twitch OAuth token.

| Column | Type | Notes |
| --- | --- | --- |
| `streamer_id` | `INT` PK | FK to `streamer.id` ON DELETE CASCADE |
| `follow_enabled` | `TINYINT(1)` | Whether follow notifications are sent |
| `follow_message` | `VARCHAR(500)` | Message template for follows |
| `sub_enabled` | `TINYINT(1)` | Whether sub/resub/giftsub notifications are sent |
| `sub_message` | `VARCHAR(500)` | New sub message template |
| `resub_message` | `VARCHAR(500)` | Resub message template |
| `giftsub_message` | `VARCHAR(500)` | Gift sub message template |
| `raid_enabled` | `TINYINT(1)` | Whether raid notifications are sent |
| `raid_message` | `VARCHAR(500)` | Raid message template |
| `raid_shoutout_enabled` | `TINYINT(1)` | Whether an automatic `!so`-style shoutout is sent for the raiding channel. Independent of `raid_enabled` — either, both, or neither may be on. |

Created by `migrations/twitch_eventsub.sql`. `raid_shoutout_enabled` added by `migrations/raid_shoutout.sql`.

## `streamer_event_log`

Live activity log for the dashboard's "Recent Events" feed: follows, subs, raids, and channel-point redemptions on a connected Twitch channel. Bounded to roughly the largest range the dashboard displays — `recordStreamerEvent()` prunes each streamer down to their most recent 200 rows on every insert, so this never grows unbounded.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK, auto-increment | |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `event_type` | `ENUM('follow','sub','resub','giftsub','raid','redemption')` | |
| `display_name` | `VARCHAR(255)` | The acting Twitch viewer's display name |
| `detail` | `VARCHAR(500)` NULL | Short additional context (e.g. raid viewer count, redeemed reward name) |
| `redemption_id` | `VARCHAR(64)` NULL, UNIQUE | Twitch's own redemption id, set only for `redemption` rows. Lets a retried `INSERT` for the same physical redemption (see `handleRedemption`'s dedup pending/handled lifecycle) collide on the unique index instead of creating a duplicate row. `NULL` for the other five event types, which have no equivalent id — a `UNIQUE` index permits any number of `NULL`s |
| `occurred_at` | `DATETIME` | Defaults to `CURRENT_TIMESTAMP` |

Created by `migrations/streamer_event_log.sql`. `redemption_id` added by `migrations/streamer_event_log_redemption_id.sql`.

## `redemption_handled`

Durable per-redemption progress for `handleRedemption`. The in-memory dedup cache only remembers a redemption for 10 minutes, but EventSub reconciliation can replay redemptions up to `MAX_CURSOR_LAG_MS` (1 hour) back. This table lets a retry or replay skip every effect that already ran, so a redemption's dashboard row and dynamic-pricing increment are applied exactly once. The overlay video and companion notification aren't tracked. `handled_at` is written just before they're sent, so a retry never replays them. Rows are pruned by age (`REDEMPTION_LEDGER_RETENTION_MS`, 6 hours) from the reconciliation tick.

| Column | Type | Notes |
| --- | --- | --- |
| `redemption_id` | `VARCHAR(64)` PK | Twitch's own redemption id |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `dashboard_recorded` | `TINYINT(1)` | 1 once the redemption's `streamer_event_log` row was recorded |
| `pricing_applied` | `TINYINT(1)` | 1 once its dynamic-pricing increment was applied. Written in the same transaction as the `reward_pricing` update (`recordPricingUpdate`), and checked inside the reward's pricing queue, so a retry never applies pricing twice |
| `handled_at` | `DATETIME` NULL | Set once every required effect succeeded. The redemption is then skipped entirely |
| `created_at` | `DATETIME` | Defaults to `CURRENT_TIMESTAMP`. The prune key (`idx_redemption_handled_created`) |

Created by `migrations/redemption_handled.sql`. The bot checks the table exists at startup (`isRedemptionLedgerReady`) and exits with an error if the migration hasn't been applied.

## `reward_pricing`

Dynamic Channel Point Pricing: per-reward config and demand state. Independent of `overlay_reward` — a reward can have dynamic pricing without overlay videos and vice versa. Optional/opt-in per reward via `enabled`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK, auto-increment | |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `twitch_reward_id` | `VARCHAR(255)` | Twitch reward UUID; unique per `(streamer_id, twitch_reward_id)` |
| `enabled` | `TINYINT(1)` | Whether dynamic pricing is active for this reward |
| `base_cost` | `INT` | Minimum price |
| `cooldown_seconds` | `INT` | Mirrors the reward's own Twitch global cooldown (or a fallback default when it has none) — kept in sync automatically, not directly editable |
| `max_multiplier` | `DECIMAL(6,3)` | Max price = `base_cost * (1 + max_multiplier)` |
| `curve` | `DECIMAL(5,3)` | Exponent controlling how aggressively price rises with demand |
| `round_to_nearest` | `INT` | Rounds the computed price to the nearest multiple of this many points (`0`, `5`, or `10`); `0` disables rounding |
| `demand` | `DECIMAL(9,6)` | Current demand, in `[0,1]` |
| `demand_updated_at` | `BIGINT` | Epoch ms the `demand` value was last computed as of |
| `last_pushed_cost` | `INT` NULL | Last cost actually pushed to Twitch; used to skip redundant Helix calls |
| `last_redemption_id` | `VARCHAR(64)` NULL | Twitch's own id of the last redemption whose increment was applied to `demand` — the idempotency guard `syncRewardPrice` checks before applying another increment, so a retried redemption (see `handleRedemption`'s dedup pending/handled lifecycle) can't double-apply. Untouched by decay-only ticks. `NULL` until this reward's first redemption-driven sync |
| `twitch_unsupported` | `TINYINT(1)` | Set (and `enabled` forced to 0) when Twitch returns 403 — the reward was created outside this app and can never be managed by it |

Created by `migrations/reward_pricing.sql`. `round_to_nearest` added by `migrations/reward_pricing_round_to_nearest.sql`. `last_redemption_id` added by `migrations/reward_pricing_last_redemption_id.sql`.

## `reward_pricing_settings`

One row per streamer — their own decay half-life and time-to-max-demand multiplier, shared by every one of their `reward_pricing` rows. The redemption increment isn't stored here; it's derived per-reward from the reward's own `cooldown_seconds` plus these two settings.

| Column | Type | Notes |
| --- | --- | --- |
| `streamer_id` | `INT` PK | FK to `streamer.id` ON DELETE CASCADE |
| `half_life_seconds` | `INT` | Fixed seconds of inactivity for demand to halve — independent of any reward's cooldown |
| `time_to_max_multiplier` | `DECIMAL(6,3)` | Redemptions at a reward's own cooldown frequency reach 100% demand after this many half-lives |

Created by `migrations/reward_pricing_settings.sql` (replaces the earlier `pricing_global_settings` singleton table from `migrations/reward_pricing.sql`).

## `reward_pricing_history`

Time-series log of computed price/demand per reward, powering the price history graph on `/channel-points`. Bounded to roughly the largest selectable time range (24h) — `recordPricingHistory()` prunes older rows for the same reward on every insert, so this table never grows unbounded.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK, auto-increment | |
| `reward_pricing_id` | `INT` | FK to `reward_pricing.id` ON DELETE CASCADE |
| `recorded_at` | `BIGINT` | Epoch ms this point was recorded at |
| `cost` | `INT` | Computed price at `recorded_at` |
| `demand` | `DECIMAL(9,6)` | Demand at `recorded_at`, in `[0,1]` |

Created by `migrations/reward_pricing_history.sql`.

## `custom_command`

Stores custom text commands managed through the admin panel. This is a **global catalog** shared across all guilds (no `guild_id`); per-guild deviations (disable / output override) live in `guild_command_override`. On Discord, every catalog command is enabled by default in every guild.

| Column | Type | Notes |
| --- | --- | --- |
| `command_id` | `INT UNSIGNED` PK | Command identifier |
| `trigger_string` | `VARCHAR(255)` | Full command token including prefix; application normalizes this to lowercase |
| `output` | `TEXT` | Response text |
| `is_discord_enabled` | `TINYINT(1)` | Whether the command is enabled for Discord-side usage |
| `is_multi_twitch` | `TINYINT(1)` | Whether the command is a multi-Twitch broadcast command: when triggered, its output goes to every channel in the sender's active multi-Twitch group that also has the command. Like any command, it only fires on the channels of streamers it's assigned to (`twitch_user_commands`), so a streamer opts out by unassigning |

Recommended index (run once):

```sql
CREATE INDEX idx_cc_trigger ON custom_command(trigger_string);
```

This index accelerates the per-message trigger lookups that scan `trigger_string` on every incoming chat message. Use `migrations/migrate_indexes.sql` for a re-runnable script that skips creation when the index already exists.

Expected constraints and behavior:

- `trigger_string` is **not** globally unique by design; the same trigger can exist on different Twitch channels.
- `trigger_string` should be stored as a single token only, including prefix, for example `!hello`.
- The application lowercases `trigger_string` before persistence so it matches runtime command lookup behavior.

Deployment note:

- Do **not** enforce a global UNIQUE constraint on `custom_command.trigger_string`; it would block valid per-channel command reuse.
- **Shared command namespace:** The application treats the union of `custom_command.trigger_string`, `counter.trigger_command`, and `counter.check_command` as a single shared command namespace. The `isAnyCommandTakenAcrossTables()` function in `src/db.ts` validates that new custom commands do not collide with existing counter commands before writing. This check is wrapped in a serialized advisory lock (`runSerializedCommandWrite()`) to prevent race conditions.
- **Channel-scoped uniqueness:** Twitch command conflicts are validated in application logic using command assignments and channel context (including multi-Twitch behavior) rather than a single table-level UNIQUE key.
- If `uq_custom_command_trigger_string` was added previously, drop it to restore channel-scoped behavior:

```sql
ALTER TABLE custom_command
    DROP INDEX uq_custom_command_trigger_string;
```

## `guild_command_override`

Sparse per-guild overlay on the **global** `custom_command` catalog. Every catalog command is enabled on Discord by default; a row here exists only where a guild has deviated. Created by `migrations/multi_guild.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `guild_id` | `BIGINT` | FK to `guild.guild_id` `ON DELETE CASCADE` |
| `command_id` | `INT UNSIGNED` | FK to `custom_command.command_id` `ON DELETE CASCADE` |
| `is_disabled` | `TINYINT(1)` | When `1`, the command does not fire on Discord in this guild |
| `output` | `TEXT` nullable | Per-guild replacement output; `NULL` means use the catalog `output` |

Resolution for a Discord message in a guild: load the global catalog command, then apply the `(guild_id, command_id)` override if present (`is_disabled = 1` ⇒ no fire; non-null `output` ⇒ replace text). **Twitch routing ignores this table** — Twitch chat has no Discord-guild context.

Expected constraints:

- Composite primary key `(guild_id, command_id)`.
- Both foreign keys use `ON DELETE CASCADE`, so deleting a catalog command or a guild removes its override rows.

## `overlay_video`

Videos a streamer has uploaded for the channel-point video overlay. Created by `migrations/overlay_videos.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK auto-increment | |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `name` | `VARCHAR(255)` | Display name shown in the overlay admin page |
| `filename` | `VARCHAR(255)` | Stored file name, a random UUID plus extension; served without auth, so the name is what keeps it unguessable |
| `created_at` | `TIMESTAMP` | Defaults to `CURRENT_TIMESTAMP` |

Expected behavior:

- Deletes are scoped by `streamer_id`, and `deleteVideo` returns the row's `filename` so the caller can remove the file from disk.

## `overlay_reward`

A streamer's Twitch channel-point rewards that trigger overlay videos. Independent of `reward_pricing`. Created by `migrations/overlay_videos.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK auto-increment | |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `twitch_reward_id` | `VARCHAR(255)` | Twitch's reward ID |

Expected constraints:

- `UNIQUE KEY uq_reward (streamer_id, twitch_reward_id)`.

## `overlay_reward_video`

Join table assigning videos to an overlay reward. A reward can have several videos, and one is picked at random by `weight` when it is redeemed (same pattern as SFX). Created by `migrations/overlay_videos.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `reward_id` | `INT` | FK to `overlay_reward.id` ON DELETE CASCADE |
| `video_id` | `INT` | FK to `overlay_video.id` ON DELETE CASCADE |
| `weight` | `INT` | Relative pick weight; defaults to 1, and the app clamps it to at least 1 |

Expected constraints and behavior:

- `PRIMARY KEY (reward_id, video_id)`.
- Saving a reward's videos replaces all its rows in one transaction, and only accepts video IDs owned by the same streamer.

## `alert_config`

Per-streamer, per-event-type configuration for the customisable alerts overlay (a browser-source SSE overlay separate from the existing channel-point video overlay). Created by `migrations/alerts_overlay.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK, auto-increment | |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `event_type` | `ENUM('follow','sub','resub','giftsub','raid')` | Which Twitch EventSub event this row configures |
| `enabled` | `TINYINT(1)` | Whether the browser-source alert fires for this event type |
| `message_template` | `VARCHAR(500)` | On-screen text template; supports the same `{placeholder}` syntax (via `fillTemplate`) as the existing chat-message templates in `streamer_event_config` |
| `image_filename` | `VARCHAR(255)` nullable | Uploaded image/GIF filename, relative to `ALERT_ASSETS_FOLDER/<streamer_id>/` |
| `sound_filename` | `VARCHAR(255)` nullable | Uploaded sound filename, relative to `ALERT_ASSETS_FOLDER/<streamer_id>/` |
| `duration_ms` | `INT` | How long the alert stays on screen before being dismissed |
| `text_animation` | `ENUM('none','wave','pulse','glitch','shake','rainbow','flicker','tilt','bounce-in','typewriter')` | On-screen text animation style applied to the message; added by `migrations/alert_config_text_animation.sql` |

Expected constraints:

- `UNIQUE KEY uq_alert_config (streamer_id, event_type)` — one row per streamer per event type.
- Independent of `streamer_event_config` (Twitch chat messages) and `overlay_reward`/`overlay_video` (channel-point video overlay) — a streamer may enable an alert for an event type without enabling the corresponding chat message, or vice versa.

## `timer_command`

Twitch-only auto-posted chat messages ("timer commands" — one message per row; a rotation is achieved by creating several timers), managed like `custom_command`: a global catalog assigned to Twitch-linked Discord users via `timer_command_streamer`, rather than owned by a single streamer. Config-only: the scheduler's live-status/chat-activity firing state lives in memory, keyed per (timer, assigned channel) pair (`timerCommandScheduler.ts`), not in this table, so a restart just restarts each one's countdown rather than replaying fires missed while the bot was down. Created by `migrations/timer_commands.sql`; moved to the assignment model by `migrations/timer_command_streamer_assignment.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK, auto-increment | |
| `name` | `VARCHAR(255)` | Admin-facing label only, never posted to chat |
| `message` | `VARCHAR(500)` | The chat message posted on each fire |
| `interval_seconds` | `INT` | Minimum time between fires; `CHECK (interval_seconds >= 60)` |
| `min_messages` | `INT` | Minimum chat lines seen since the timer's last fire, in addition to the interval; `0` disables this gate; `CHECK (min_messages >= 0)` |
| `require_live` | `TINYINT(1)` | When `1`, the timer only fires while the assigned channel is live |
| `enabled` | `TINYINT(1)` | Whether the scheduler considers this timer at all |

Firing logic (see `timerCommandScheduler.ts`): on a 15s tick, each of a timer's assigned channels is evaluated independently — it fires once its own interval has elapsed **and** (if `require_live`) that channel is live **and** at least `min_messages` chat lines have been seen on that channel since its last fire. A newly-seen (timer, channel) pair (first tick after creation/assignment or bot restart) seeds its clock and chat-line baseline without firing, so restarts don't cause a burst of immediate posts. When several assigned channels are merged into one Twitch Shared Chat session, a shared cooldown across that session's timers prevents flooding the merged chat — see the "Shared Chat group cooldown" section of `timerCommandScheduler.ts`.

## `timer_command_streamer`

Join table mapping timer commands to the Discord users (Twitch streamers) they're assigned to. Mirrors `twitch_user_commands`. Added by `migrations/timer_command_streamer_assignment.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `timer_id` | `INT` | FK to `timer_command.id` ON DELETE CASCADE |
| `discord_id` | `BIGINT` | FK to `user.discord_id` ON DELETE CASCADE |

Expected constraints:

- `PRIMARY KEY (timer_id, discord_id)` — a user can only be assigned to a given timer once.

## `streamdeck_api_keys`

Per-user Streamdeck API keys: one key per user, shared across every guild they can access. Per-guild approval state lives in `streamdeck_key_guild_status`. Defined in `schema.sql`; `migrations/streamdeck_multi_guild.sql` split the older one-guild-per-key shape (with `guild_id`/`status`/`requested_at`/`approved_at`/`approved_by` on this table) into the two tables.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` PK | Key owner (one key per user) |
| `key_hash` | `VARCHAR(64)` | Hex SHA-256 hash of the plaintext key |
| `created_at` | `DATETIME` | When the key was issued or last regenerated |

## `streamdeck_key_guild_status`

Per-guild approval state for a Streamdeck key: the same key can be pending in one guild, approved in another and revoked or denied in a third. Created by `migrations/streamdeck_multi_guild.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` | FK to `streamdeck_api_keys.discord_id` ON DELETE CASCADE |
| `guild_id` | `BIGINT` | FK to `guild.guild_id` ON DELETE CASCADE |
| `status` | `ENUM('pending','approved','revoked','denied')` | Defaults to `pending` |
| `requested_at` | `DATETIME` | When access to this guild was requested |
| `approved_at` | `DATETIME` nullable | When approved |
| `approved_by` | `BIGINT` nullable | Approver's `discord_id`; FK to `user.discord_id` ON DELETE SET NULL |

Expected constraints and behavior:

- `PRIMARY KEY (discord_id, guild_id)`.
- Re-requesting access upserts the row but leaves a `denied` row unchanged, so a denied user can't re-queue themselves (`src/db/streamdeckKeys.ts`).
- An `approved` row alone doesn't grant access: lookups also require the key owner to still be a `guild_member` of that guild (or `user.is_owner`), because removing a member doesn't revoke their Streamdeck approvals.
- On older deployments `discord_id` may be `VARCHAR(64)` to match a pre-`BIGINT` `streamdeck_api_keys.discord_id`; see the comment at the top of the migration.

## `twitch_user_commands`

Join table mapping users to custom commands.

| Column | Type | Notes |
| --- | --- | --- |
| `command_id` | `INT UNSIGNED` | FK to `custom_command.command_id` |
| `discord_id` | `BIGINT` | FK to `user.discord_id` |

Expected constraints and behavior:

- Composite primary key or unique constraint on `command_id, discord_id`.
- Foreign key from `command_id` to `custom_command.command_id`.
- Foreign key from `discord_id` to `user.discord_id`.
- `ON DELETE CASCADE` is preferred on both foreign keys so deleting a command or user automatically removes mapping rows.

## `counter`

Stores counter command definitions and values managed through the admin panel.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Counter row identifier |
| `guild_id` | `BIGINT` | FK to `guild.guild_id`; counters are per-guild |
| `trigger_command` | `VARCHAR(...)` | Full command token used for increment actions (including prefix) |
| `check_command` | `VARCHAR(...)` | Full command token used for read/check actions |
| `message` | `TEXT` | Read/check reply template; `%d` placeholder is used for current value |
| `increment_message` | `TEXT` | Increment reply template; `%d` placeholder is used for incremented value |
| `reset_yearly` | `BIT(1)` or `TINYINT(1)` | Whether yearly archival should reset `current_value` |
| `current_value` | `INT` | Current live value |
| `value2020`-`value2025` | `INT` nullable | Existing yearly archive columns; the counter scheduler adds each later `valueYYYY` column (`INT NULL`) itself before archiving that year, so the bot's DB user needs `ALTER` on `counter` |

Expected constraints and behavior:

- `trigger_command` and `check_command` should be unique **per guild** (the same counter command may exist in different guilds).
- Both command columns should store single-token commands including any prefix.
- The admin panel (CRUD and manual reset of `current_value`) and runtime chat-command matching/increment are both guild-scoped by `guild_id`.

Per-guild uniqueness (applied by `migrations/multi_guild.sql`, which also drops any earlier global `uq_counter_*` constraints):

```sql
ALTER TABLE counter
    ADD CONSTRAINT uq_counter_guild_trigger UNIQUE (guild_id, trigger_command),
    ADD CONSTRAINT uq_counter_guild_check   UNIQUE (guild_id, check_command);

CREATE INDEX idx_counter_trigger ON counter(trigger_command);
CREATE INDEX idx_counter_check   ON counter(check_command);
```

The two indexes accelerate per-message trigger lookups that scan both command columns on every incoming chat message. Use `migrations/migrate_indexes.sql` for a re-runnable script that skips creation when an index already exists.

Deployment note:

- **Recommended (defense-in-depth):** Apply these UNIQUE constraints during deployment/bootstrap. They provide DB-level protection against duplicate `trigger_command` and duplicate `check_command` rows, especially for direct DB writes, manual SQL, or future regressions.
- For current application requests, counter writes are already serialized through `runSerializedCommandWrite()` + MySQL named locks and guarded by `isAnyCommandTakenAcrossTables()` before writes, so concurrent app requests should not create duplicates even without these two column-level UNIQUE constraints.

**Important limitation:** The column-level UNIQUE constraints do **not** prevent **cross-column collisions** within the same table — for example, one row's `trigger_command` could equal another row's `check_command`. Since the application treats the union of both columns as a shared command namespace with `custom_command.trigger_string`, this is a potential consistency gap.

**Runtime protection:** The application layer mitigates this risk via `isAnyCommandTakenAcrossTables()` in `src/db.ts`. This function is called within `runSerializedCommandWrite()`, which acquires MySQL advisory locks and queries both `trigger_command` and `check_command` (as well as `custom_command.trigger_string`) in a single atomic check before writing. This prevents concurrent collisions across the entire command namespace. The DB-level UNIQUE constraints provide an additional fallback in case of application-layer bugs or direct DB access.

**Optional DB-level enforcement:** For additional safety at the database level, you can:

1. Add a database trigger that validates both `trigger_command` and `check_command` against the union of all command columns, or
2. Create a separate `command_registry` table with a `UNIQUE KEY` on the command string, then add foreign keys from both `trigger_command` and `check_command` to that table, or
3. Use a generated column approach (MySQL 8.0.13+): add a generated column that represents the command token and enforce uniqueness on it.

For now, the recommended migration is the two separate UNIQUE constraints above; the application-layer atomic checks provide sufficient protection for typical operations.

## `counter_archive_run`

Persistent marker for the yearly counter archive/reset (`archiveAndResetYearlyCounters` in `src/db/counters.ts`, driven hourly by `src/commands/counterScheduler.ts`). Added by `migrations/counter_archive_runs.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `archive_year` | `SMALLINT UNSIGNED` PK | Calendar year whose `value<year>` archive + `current_value` reset has run |
| `archived_at` | `DATETIME` | When the archive ran; defaults to `CURRENT_TIMESTAMP` |

Behavior:

- The archive claims its year with `INSERT IGNORE` in the **same transaction** as the archive `UPDATE`; if the row already exists the `UPDATE` is skipped. A failed `UPDATE` rolls the marker back, so the next tick retries.
- This makes the archive idempotent, so the scheduler attempts the previous year's archive on every tick (not only on 1 January) and catches up after downtime spanning the year boundary.
- **Seeded with the previous calendar year** (`INSERT IGNORE ... VALUES (YEAR(CURDATE()) - 1)`) by both the migration and `schema.sql`, so deploying mid-year doesn't immediately re-archive/reset last year (which would zero this year's progress). Delete that row by hand only if last year's archive was genuinely missed and should run now.
- Before the transaction, the archive adds the year's `value<year>` column to `counter` if it's missing (DDL implicitly commits, so it can't run inside the transaction). A concurrent add is tolerated.
- If the table is missing, or the column can't be added (e.g. the DB user lacks `ALTER`), each tick logs an error and records a failed `counter` scheduler run instead of archiving.

## `companion_app_tokens`

Self-service bearer tokens for the companion app: one active token per user, no approval queue, used only for read-only delivery of the user's own Twitch channel-point redemption events. Created by `migrations/companion_app_tokens.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` PK | Token owner; FK to `user.discord_id` ON DELETE CASCADE |
| `key_hash` | `VARCHAR(64)` | SHA-256 hash of the plaintext token; unique |
| `created_at` | `DATETIME` | When the current token was issued |
| `revoked_at` | `DATETIME` nullable | When the token was revoked; `NULL` while active |

Expected constraints and behavior:

- `UNIQUE KEY uq_companion_app_tokens_key_hash (key_hash)`.
- Issuing a new token for a user replaces any existing row (upsert on `discord_id`) and clears `revoked_at` — a user has at most one active token at a time.
- Lookup by hash (`findDiscordIdByTokenHash` in `src/db/companionTokens.ts`) only matches rows where `revoked_at IS NULL`, then re-verifies with a timing-safe comparison since the table's collation is case-insensitive.

## `companion_oauth_codes`

Short-lived, single-use authorization codes for the companion app's loopback OAuth login flow (exchanged for a `companion_app_tokens` row). Created by `migrations/companion_app_tokens.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `code_hash` | `VARCHAR(64)` PK | SHA-256 hash of the plaintext code |
| `discord_id` | `BIGINT` | FK to `user.discord_id` ON DELETE CASCADE; the user the code resolves to once consumed |
| `expires_at` | `DATETIME` | Computed DB-side as `NOW() + 60 seconds` at creation, so it stays consistent with the consuming query even if the app and DB clocks drift |
| `used_at` | `DATETIME` nullable | Set when the code is consumed; `NULL` while still redeemable |

Expected constraints and behavior:

- Consuming a code (`consumeCodeOnConnection` in `src/db/companionOAuthCodes.ts`) is a single `UPDATE ... WHERE used_at IS NULL AND expires_at > NOW()`, so concurrent redemption attempts of the same code cannot both succeed.
- `exchangeCodeForToken()` marks the code used and issues the companion token in one DB transaction, so a failure issuing the token rolls back the "used" mark instead of permanently burning the code.

## `webauthn_credentials`

Passkeys (WebAuthn credentials) for fingerprint / face / device-PIN sign-in to the web panel. A user adds one from User Settings after signing in with Discord; afterwards the login page's passkey button signs them in directly. Created by `migrations/webauthn_credentials.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `credential_id` | `VARCHAR(512)` PK, `ascii_bin` | base64url credential ID from the authenticator; binary collation because IDs are case-sensitive |
| `discord_id` | `BIGINT` | FK to `user.discord_id` ON DELETE CASCADE; the passkey's owner |
| `user_handle` | `VARCHAR(128)`, `ascii_bin` | base64url WebAuthn user handle: random 32 bytes chosen at a user's first registration and reused for their later passkeys. Sign-in checks the assertion's `userHandle` against it. Stored (not derived from an app secret) so secret rotation never invalidates passkeys |
| `public_key` | `VARBINARY(1024)` | COSE-encoded credential public key |
| `sign_count` | `INT UNSIGNED` | WebAuthn signature counter (32-bit by spec, so read as a plain number); updated on each sign-in |
| `transports` | `VARCHAR(255)` nullable | Comma-separated transport hints (`internal`, `hybrid`, ...) |
| `device_label` | `VARCHAR(100)` | User-chosen name shown in User Settings |
| `created_at` | `DATETIME` | Defaults to `CURRENT_TIMESTAMP` |
| `last_used_at` | `DATETIME` nullable | Last successful sign-in with this passkey |

Expected constraints and behavior:

- `KEY idx_webauthn_credentials_discord_id (discord_id)` for the per-user listing on the settings page.
- Deleting a passkey (`deletePasskey` in `src/db/webauthnCredentials.ts`) is scoped by `discord_id`, so a user can only remove their own.
- A passkey never bypasses the whitelist: sign-in re-checks the `user` row and guild access exactly like the Discord OAuth callback, so removing a user (which cascades here) or all their guild memberships locks them out.

## `webauthn_challenges`

Outstanding WebAuthn (passkey) challenges, one row per issued challenge. Created by `migrations/webauthn_credentials.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `challenge` | `VARCHAR(128)` PK, `ascii_bin` | base64url challenge from the generated registration/authentication options |
| `purpose` | `ENUM('register','login')` | The ceremony it was issued for; a login challenge can't complete a registration or vice versa |
| `expires_at` | `DATETIME` | Computed DB-side as `NOW() + 5 minutes` at creation |

Expected constraints and behavior:

- The challenge is also kept on the session, binding it to the browser that requested it; this table is what makes it single-use. `consumeWebauthnChallenge` (`src/db/webauthnChallenges.ts`) is one `DELETE ... WHERE challenge = ? AND purpose = ? AND expires_at > NOW()`, so of two concurrent verifications with the same challenge exactly one gets `affectedRows = 1`.
- `saveWebauthnChallenge` prunes expired rows before each insert, so abandoned challenges don't accumulate (issuing is rate-limited by `authLimiter`).

## `passkey_enrollment_codes`

One-time confirmation codes the bot DMs to a user before they can add a passkey, proving they control the Discord account and not just a web session. Created by `migrations/webauthn_credentials.sql`.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` PK | FK to `user.discord_id` ON DELETE CASCADE; one outstanding code per user |
| `code_hash` | `CHAR(64)`, `ascii_bin` | SHA-256 hex digest of the 6-digit code; the code itself is never stored |
| `attempts` | `TINYINT UNSIGNED` | Guesses spent on this code |
| `sent_at` | `DATETIME` | When the code was issued (DB-side `NOW()`); drives the resend cooldown |
| `expires_at` | `DATETIME` | DB-side `NOW() + 5 minutes` |

Expected constraints and behavior:

- `savePasskeyEnrollmentCode` (`src/db/passkeyEnrollmentCodes.ts`) prunes expired rows, replaces the user's code only if it is older than the 60-second resend cooldown, then does a plain `INSERT`; the primary key makes a concurrent second send fail as a duplicate, so the cooldown holds.
- `consumePasskeyEnrollmentCode` first spends an attempt with `UPDATE ... SET attempts = attempts + 1 WHERE discord_id = ? AND expires_at > NOW() AND attempts < 5`, and only then compares, with a `DELETE ... WHERE discord_id = ? AND code_hash = ?` that consumes a matching code. Concurrent guesses therefore can't exceed 5 per code.
- If the DM carrying a code can't be delivered, `deletePasskeyEnrollmentCode` removes that code by `discord_id` **and** `code_hash`, so a late cleanup never deletes a newer code issued to the same user.

## `sessions`

Managed automatically by `express-mysql-session`.

This table is not maintained manually in this repository. It is created on first run if missing and used to store Express session data for the web panel.
