-- Web panel sessions (express-session via express-mysql-session). The store used to create this
-- table itself on first run; it is now created here so every table comes from migrations/ and
-- the store runs with createDatabaseTable off. The definition matches the store's own schema.sql,
-- so on an existing database IF NOT EXISTS leaves the table (and its live sessions) untouched.
CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) COLLATE utf8mb4_bin NOT NULL,
  expires    INT UNSIGNED NOT NULL,
  data       MEDIUMTEXT   COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
