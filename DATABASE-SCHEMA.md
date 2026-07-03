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

## `reward_pricing`

Dynamic Channel Point Pricing: per-reward config and demand state. Independent of `overlay_reward` — a reward can have dynamic pricing without overlay videos and vice versa. Optional/opt-in per reward via `enabled`.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK, auto-increment | |
| `streamer_id` | `INT` | FK to `streamer.id` ON DELETE CASCADE |
| `twitch_reward_id` | `VARCHAR(255)` | Twitch reward UUID; unique per `(streamer_id, twitch_reward_id)` |
| `enabled` | `TINYINT(1)` | Whether dynamic pricing is active for this reward |
| `base_cost` | `INT` | Minimum price |
| `cooldown_seconds` | `INT` | Used to normalize demand decay/increment across rewards |
| `max_multiplier` | `DECIMAL(6,3)` | Max price = `base_cost * (1 + max_multiplier)` |
| `curve` | `DECIMAL(5,3)` | Exponent controlling how aggressively price rises with demand |
| `demand` | `DECIMAL(9,6)` | Current demand, in `[0,1]` |
| `demand_updated_at` | `BIGINT` | Epoch ms the `demand` value was last computed as of |
| `last_pushed_cost` | `INT` NULL | Last cost actually pushed to Twitch; used to skip redundant Helix calls |
| `twitch_unsupported` | `TINYINT(1)` | Set (and `enabled` forced to 0) when Twitch returns 403 — the reward was created outside this app and can never be managed by it |

Created by `migrations/reward_pricing.sql`.

## `pricing_global_settings`

Single global row (`id` pinned to 1) — bot-wide decay/increment settings shared by every `reward_pricing` row.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `TINYINT` PK | Always `1` (enforced by a CHECK constraint) |
| `decay_half_life_periods` | `DECIMAL(8,3)` | Cooldown-periods of inactivity for demand to halve |
| `redemption_increment` | `DECIMAL(6,4)` | Flat demand increase applied per redemption |

Created by `migrations/reward_pricing.sql`.

## `custom_command`

Stores custom text commands managed through the admin panel. This is a **global catalog** shared across all guilds (no `guild_id`); per-guild deviations (disable / output override) live in `guild_command_override`. On Discord, every catalog command is enabled by default in every guild.

| Column | Type | Notes |
| --- | --- | --- |
| `command_id` | `INT UNSIGNED` PK | Command identifier |
| `trigger_string` | `VARCHAR(255)` | Full command token including prefix; application normalizes this to lowercase |
| `output` | `TEXT` | Response text |
| `is_discord_enabled` | `TINYINT(1)` | Whether the command is enabled for Discord-side usage |
| `is_multi_twitch` | `TINYINT(1)` | Whether the command is treated as a multi-Twitch broadcast command |

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

## `streamdeck_api_keys`

Per-user Streamdeck API keys. Defined in `schema.sql`. For existing deployments where this table was created externally (before the multi-guild migration), `migrations/multi_guild.sql` conditionally adds the `guild_id` column.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` PK | Key owner (one key per user) |
| `key_hash` | `VARCHAR(...)` | SHA-256 hash of the plaintext key |
| `guild_id` | `BIGINT` | FK to `guild.guild_id`; the guild this key acts on |
| `status` | `ENUM`/`VARCHAR` | `pending`, `approved`, `revoked`, or `denied` |
| `requested_at` | `DATETIME` | When the key was requested |
| `approved_at` | `DATETIME` nullable | When approved |
| `approved_by` | `BIGINT` nullable | Approver's `discord_id` |

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
| `value2020`-`value2025` | `INT` nullable | Existing yearly archive columns; additional `valueYYYY` columns may be added over time |

Expected constraints and behavior:

- `trigger_command` and `check_command` should be unique **per guild** (the same counter command may exist in different guilds).
- Both command columns should store single-token commands including any prefix.
- Current panel support includes CRUD and manual reset of `current_value`; runtime command handling/scheduler wiring can be implemented independently.

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

## `sessions`

Managed automatically by `express-mysql-session`.

This table is not maintained manually in this repository. It is created on first run if missing and used to store Express session data for the web panel.
