ALTER TABLE `calendar_items` ADD `workflow_name` text;--> statement-breakpoint
ALTER TABLE `calendar_items` ADD `thread_mode` text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_items` ADD `thread_id` text;--> statement-breakpoint
ALTER TABLE `card_occurrences` ADD `thread_id` text;--> statement-breakpoint
-- Event triggers are gone with their settings (orchestrator threads spec 29); a card's own
-- trigger stays.
DELETE FROM `trigger_events`;--> statement-breakpoint
DELETE FROM `triggers` WHERE `kind` = 'event';--> statement-breakpoint
DELETE FROM `settings` WHERE `key` LIKE 'triggers.%';
