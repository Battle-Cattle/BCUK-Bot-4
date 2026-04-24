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

## `user`

Stores web/admin users plus Twitch bot participation state.

| Column | Type | Notes |
| --- | --- | --- |
| `discord_id` | `BIGINT` PK | Discord numeric user ID |
| `discord_name` | `VARCHAR(...)` nullable | Last synced display name |
| `is_twitch_bot_enabled` | `BIT(1)` or `TINYINT(1)` | Whether the Twitch bot should join this user's Twitch channel |
| `twitch_name` | `VARCHAR(...)` nullable | Twitch channel name; should be unique when non-null |
| `twitchoauth` | `VARCHAR(...)` nullable | Legacy/optional Twitch auth storage |
| `access_level` | `INT` | `0=USER`, `1=MOD`, `2=MANAGER`, `3=ADMIN` |

Expected constraints and behavior:

- `twitch_name` should use a case-insensitive collation so uniqueness is enforced without case sensitivity.
- Blank Twitch names should be stored as `NULL`, not empty strings.

## `stream_group`

Stores configuration for Twitch announcement groups.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Group identifier |
| `name` | `VARCHAR(...)` | Display name |
| `discord_channel` | `BIGINT` | Channel ID for announcements |
| `live_message` | `TEXT` | Go-live message template |
| `new_game_message` | `TEXT` | Game-change message template |
| `multi_twitch` | `BIT(1)` or `TINYINT(1)` | Enables multitwitch footer generation |
| `multi_twitch_message` | `TEXT` | Footer template containing `{multitwitch}` |
| `delete_old_posts` | `BIT(1)` or `TINYINT(1)` | Delete old announcement on game change instead of editing |

## `streamer`

Stores monitored Twitch streamers and their current Discord post state.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `INT` PK | Streamer row identifier |
| `name` | `VARCHAR(...)` | Lowercase Twitch username |
| `group_id` | `INT` | FK to `stream_group.id` |
| `discord_message_id` | `VARCHAR(20)` nullable | ID of the last announcement message |
| `discord_channel_id` | `BIGINT` nullable | Channel where the last message was posted |
| `live_game` | `VARCHAR(255)` nullable | Last seen live game |

## `custom_command`

Stores custom text commands managed through the admin panel.

| Column | Type | Notes |
| --- | --- | --- |
| `command_id` | `INT UNSIGNED` PK | Command identifier |
| `trigger_string` | `VARCHAR(255)` | Full command token including prefix; application normalizes this to lowercase |
| `output` | `TEXT` | Response text |
| `is_discord_enabled` | `TINYINT(1)` | Whether the command is enabled for Discord-side usage |
| `is_multi_twitch` | `TINYINT(1)` | Whether the command is treated as a multi-Twitch broadcast command |

Expected constraints and behavior:

- `trigger_string` should be unique.
- `trigger_string` should be stored as a single token only, including prefix, for example `!hello`.
- The application lowercases `trigger_string` before persistence so it matches runtime command lookup behavior.

Recommended migration (run once) for DB-level protection:

```sql
ALTER TABLE custom_command
    ADD CONSTRAINT uq_custom_command_trigger_string UNIQUE (trigger_string);
```

Deployment note:

- Apply this migration as part of deployment/bootstrap. The `trigger_string` column should have a UNIQUE constraint to prevent duplicates within the `custom_command` table itself.
- **Shared command namespace:** The application treats the union of `custom_command.trigger_string`, `counter.trigger_command`, and `counter.check_command` as a single shared command namespace. The `isAnyCommandTakenAcrossTables()` function in `src/db.ts` validates that new custom commands do not collide with existing counter commands before writing. This check is wrapped in a serialized advisory lock (`runSerializedCommandWrite()`) to prevent race conditions.
- **Related deployments:** This migration must be applied alongside the counter table constraints (in the `counter` section below). Both sets of UNIQUE constraints work together to provide DB-level protection; the application's advisory locks add an atomicity layer.

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
| `trigger_command` | `VARCHAR(...)` | Full command token used for increment actions (including prefix) |
| `check_command` | `VARCHAR(...)` | Full command token used for read/check actions |
| `message` | `TEXT` | Read/check reply template; `%d` placeholder is used for current value |
| `increment_message` | `TEXT` | Increment reply template; `%d` placeholder is used for incremented value |
| `reset_yearly` | `BIT(1)` or `TINYINT(1)` | Whether yearly archival should reset `current_value` |
| `current_value` | `INT` | Current live value |
| `value2020`-`value2025` | `INT` nullable | Existing yearly archive columns; additional `valueYYYY` columns may be added over time |

Expected constraints and behavior:

- `trigger_command` and `check_command` should be unique.
- Both command columns should store single-token commands including any prefix.
- Current panel support includes CRUD and manual reset of `current_value`; runtime command handling/scheduler wiring can be implemented independently.

Recommended migrations (run once) for DB-level protection:

```sql
ALTER TABLE counter
    ADD CONSTRAINT uq_counter_trigger_command UNIQUE (trigger_command),
    ADD CONSTRAINT uq_counter_check_command UNIQUE (check_command);
```

Deployment note:

- **CRITICAL:** Apply these UNIQUE constraints during deployment/bootstrap. These migrations must be executed before the application starts in production. They prevent duplicate `trigger_command` and duplicate `check_command` rows within the `counter` table. Without these constraints, concurrent requests could slip duplicate rows past the application-layer checks.

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
