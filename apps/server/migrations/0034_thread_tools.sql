CREATE TABLE `thread_tools` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`tools` text NOT NULL,
	`source` text NOT NULL,
	`live` integer NOT NULL,
	`reported_at` text NOT NULL
);
