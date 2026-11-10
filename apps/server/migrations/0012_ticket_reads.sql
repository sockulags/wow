CREATE TABLE `ticket_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text NOT NULL,
	`host` text NOT NULL,
	`host_name` text NOT NULL,
	`key` text,
	`source` text,
	`ticket` text,
	`fetched_at` text,
	`error` text
);
