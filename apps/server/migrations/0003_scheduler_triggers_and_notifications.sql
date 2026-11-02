CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`path` text NOT NULL,
	`run_id` text,
	`calendar_item_id` text
);
--> statement-breakpoint
ALTER TABLE `triggers` ADD `offer_run_now` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `triggers_card_idx` ON `triggers` (`calendar_item_id`);