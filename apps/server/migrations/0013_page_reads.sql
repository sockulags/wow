CREATE TABLE `page_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`host` text NOT NULL,
	`host_name` text NOT NULL,
	`pages` text NOT NULL,
	`fetched_at` text,
	`error` text
);
--> statement-breakpoint
ALTER TABLE `change_requests` ADD `links` text DEFAULT '[]' NOT NULL;