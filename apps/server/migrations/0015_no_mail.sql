DROP TABLE `mail_items`;--> statement-breakpoint
ALTER TABLE `outlook_status` DROP COLUMN `unread_count`;--> statement-breakpoint
DELETE FROM `settings` WHERE `key` IN ('outlook.folders', 'outlook.mailRail', 'outlook.mailRailCollapsed', 'outlook.mailLimit', 'keybindings.toggleMailRail');--> statement-breakpoint
UPDATE `events` SET `payload` = json_remove(`payload`, '$.mailUpsert', '$.mailRemove', '$.unreadCount') WHERE `kind` = 'outlook.synced';--> statement-breakpoint
DELETE FROM `command_receipts` WHERE `command_type` = 'outlook.sync';
