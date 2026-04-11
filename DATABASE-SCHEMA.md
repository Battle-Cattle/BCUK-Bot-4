# Database Schema

This project targets an existing MySQL 8 database. The application code in this repository assumes the tables below already exist.

Schema changes are managed outside this repository. This file documents the expected database contract for local setup, deployment, and review.

## General Notes

- MySQL version: 8.x
- Character set: `utf8mb4`
- Discord IDs and other snowflake-style IDs should be stored as `BIGINT` in MySQL and treated as strings in application code.
- Boolean-like columns may be returned by `mysql2` as `Buffer` or numeric values depending on server/driver configuration.
- `express-mysql-session` manages the `sessions` table automatically on first run when enabled.

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

## `twitch_user_commands`

Join table mapping users to custom commands.

| Column | Type | Notes |
| --- | --- | --- |
| `command_id` | `INT UNSIGNED` | FK to `custom_command.command_id` |
| `discord_id` | `BIGINT` | FK to `user.discord_id` |

Expected constraints and behavior:

- Composite primary key or unique constraint on `(`command_id`, `discord_id`)`.
- Foreign key from `command_id` to `custom_command.command_id`.
- Foreign key from `discord_id` to `user.discord_id`.
- `ON DELETE CASCADE` is preferred on both foreign keys so deleting a command or user automatically removes mapping rows.

## `sessions`

Managed automatically by `express-mysql-session`.

This table is not maintained manually in this repository. It is created on first run if missing and used to store Express session data for the web panel.