CREATE TABLE `restore_points` (
	`item_id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`before` text,
	`after` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `restore_points_thread_idx` ON `restore_points` (`thread_id`);--> statement-breakpoint
ALTER TABLE `turns` ADD `start_snapshot` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `end_snapshot` text;