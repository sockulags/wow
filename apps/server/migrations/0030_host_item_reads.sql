CREATE TABLE `host_item_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`thread_id` text NOT NULL,
	`item` text NOT NULL,
	`host_name` text NOT NULL,
	`data` text,
	`fetched_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `host_item_reads_thread_idx` ON `host_item_reads` (`thread_id`);