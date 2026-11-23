-- The helper tools are always on for main threads now (orchestrator threads spec 3), so the
-- project switch chat.helpers is gone with its stored values.
DELETE FROM `settings` WHERE `key` = 'chat.helpers';
