-- The sub/resub default templates showed the raw tier value (e.g. "1000")
-- instead of the human-readable tier name ("Tier 1"). Swap {tier} for
-- {tier_name} in both the column defaults and any already-stored messages
-- that still use the raw placeholder.

ALTER TABLE streamer_event_config
  MODIFY COLUMN sub_message   VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for subscribing! (Tier {tier_name})',
  MODIFY COLUMN resub_message VARCHAR(500) NOT NULL DEFAULT 'Thanks {display_name} for {months} months! (Tier {tier_name})';

UPDATE streamer_event_config
SET sub_message = REPLACE(sub_message, '{tier}', '{tier_name}')
WHERE sub_message LIKE '%{tier}%';

UPDATE streamer_event_config
SET resub_message = REPLACE(resub_message, '{tier}', '{tier_name}')
WHERE resub_message LIKE '%{tier}%';
