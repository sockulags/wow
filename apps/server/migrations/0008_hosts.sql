CREATE TABLE `change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`host` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`url` text NOT NULL,
	`state` text NOT NULL,
	`draft` integer NOT NULL,
	`merged_at` text,
	`head_branch` text NOT NULL,
	`head_sha` text NOT NULL,
	`units` text NOT NULL,
	`check_state` text NOT NULL,
	`checks` text NOT NULL,
	`comments` text NOT NULL,
	`newest_comment_id` text
);
--> statement-breakpoint
CREATE TABLE `host_reads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`scope` text NOT NULL,
	`host` text NOT NULL,
	`host_name` text NOT NULL,
	`branch` text,
	`change_request_ids` text NOT NULL,
	`fetched_at` text,
	`error` text
);
--> statement-breakpoint
ALTER TABLE `plan_intents` ADD `followed` integer DEFAULT false NOT NULL;