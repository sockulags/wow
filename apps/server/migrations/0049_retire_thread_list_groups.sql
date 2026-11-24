-- The thread list orders main threads by status (orchestrator threads spec 30 to 32), so its
-- groups, its folded groups and its second-line parts are gone with their stored values.
DELETE FROM `settings` WHERE `key` IN ('chat.threadListGroupBy', 'chat.threadListFolded', 'chat.threadRowDetail');
