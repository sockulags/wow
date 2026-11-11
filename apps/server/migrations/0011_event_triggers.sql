CREATE TABLE `trigger_events` (
	`trigger_id` text NOT NULL,
	`event_id` text NOT NULL,
	`run_id` text,
	`at` text NOT NULL,
	PRIMARY KEY(`trigger_id`, `event_id`)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'card' NOT NULL,
	`calendar_item_id` text,
	`workflow_id` text NOT NULL,
	`run_at` text,
	`zone` text,
	`state` text,
	`run_id` text,
	`offer_run_now` integer DEFAULT false NOT NULL,
	`project_id` text,
	`event` text,
	`enabled` integer,
	`created_at` text
);
--> statement-breakpoint
INSERT INTO `__new_triggers`("id", "kind", "calendar_item_id", "workflow_id", "run_at", "zone", "state", "run_id", "offer_run_now") SELECT "id", 'card', "calendar_item_id", "workflow_id", "run_at", "zone", "state", "run_id", "offer_run_now" FROM `triggers`;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `__new_triggers` RENAME TO `triggers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `triggers_due_idx` ON `triggers` (`state`,`run_at`);--> statement-breakpoint
CREATE INDEX `triggers_card_idx` ON `triggers` (`calendar_item_id`);--> statement-breakpoint
CREATE INDEX `triggers_project_idx` ON `triggers` (`project_id`);--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `event` text;