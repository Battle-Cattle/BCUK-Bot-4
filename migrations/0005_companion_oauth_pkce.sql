-- PKCE (RFC 7636) for the companion app's loopback OAuth login: the S256 challenge the app sent
-- to /companion/login, stored with the one-time code it was issued for. The token exchange then
-- only succeeds with the matching code_verifier. NULL for an app that didn't send one, which
-- still exchanges its code without a verifier.
ALTER TABLE companion_oauth_codes
  ADD COLUMN code_challenge VARCHAR(64) NULL;
