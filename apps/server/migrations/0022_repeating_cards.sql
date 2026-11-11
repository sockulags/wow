CREATE TABLE `card_occurrences` (
	`card_id` text NOT NULL,
	`date` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`outcome` text NOT NULL,
	`run_id` text,
	`reason` text,
	`offer_run_now` integer DEFAULT false NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`card_id`, `date`)
);
--> statement-breakpoint
ALTER TABLE `calendar_items` ADD `repeat` text;--> statement-breakpoint
ALTER TABLE `calendar_items` ADD `skipped_dates` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `calendar_items` ADD `next_at` text;--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `occurrence` text;--> statement-breakpoint
UPDATE `calendar_items` SET `next_at` = (SELECT `run_at` FROM `triggers` WHERE `triggers`.`calendar_item_id` = `calendar_items`.`id` AND `triggers`.`kind` = 'card' AND `triggers`.`state` = 'scheduled');
