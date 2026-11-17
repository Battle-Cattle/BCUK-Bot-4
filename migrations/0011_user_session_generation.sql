-- "Sign out other sessions" (#1058): a per-user counter copied into each web panel session at
-- login. Bumping it ends every session that holds an older value; the session that bumped it is
-- re-issued with the new one. Sessions from before this column carry no value and count as 0.
ALTER TABLE `user` ADD COLUMN session_generation INT UNSIGNED NOT NULL DEFAULT 0;
