CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`item_id` text NOT NULL,
	`kind` text NOT NULL,
	`request` text NOT NULL,
	`decision` text,
	`decided_at` text
);
--> statement-breakpoint
CREATE INDEX `approvals_thread_idx` ON `approvals` (`thread_id`);--> statement-breakpoint
CREATE TABLE `backlog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text NOT NULL,
	`state` text NOT NULL,
	`run_id` text,
	`remote` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `calendar_items` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text,
	`title` text NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`zone` text NOT NULL,
	`location` text,
	`join_url` text,
	`body` text,
	`project_id` text,
	`backlog_item_id` text,
	`workflow_id` text,
	`run_id` text,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `calendar_items_start_idx` ON `calendar_items` (`start`);--> statement-breakpoint
CREATE TABLE `command_receipts` (
	`command_id` text PRIMARY KEY NOT NULL,
	`command_type` text NOT NULL,
	`fingerprint` text NOT NULL,
	`seqs` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`kind` text NOT NULL,
	`aggregate` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mail_items` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text NOT NULL,
	`folder` text NOT NULL,
	`from` text NOT NULL,
	`subject` text NOT NULL,
	`received_at` text NOT NULL,
	`unread` integer NOT NULL,
	`snippet` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outlook_status` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_sync_at` text,
	`last_error` text,
	`bridge_version` text
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL,
	`default_provider_instance_id` text,
	`default_model` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`binary_path` text NOT NULL,
	`config_dir` text NOT NULL,
	`env` text NOT NULL,
	`launch_args` text NOT NULL,
	`default_model` text,
	`default_effort` text,
	`default_permission_mode` text,
	`status` text NOT NULL,
	`account` text
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`item_id` text NOT NULL,
	`request` text NOT NULL,
	`answer` text,
	`answered_at` text
);
--> statement-breakpoint
CREATE INDEX `questions_thread_idx` ON `questions` (`thread_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`key`, `scope`)
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`dir` text NOT NULL,
	`source` text NOT NULL,
	`manual_only` integer NOT NULL,
	`invocations` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thread_items` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`index` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`streaming` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `thread_items_thread_idx` ON `thread_items` (`thread_id`,`index`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`cwd` text NOT NULL,
	`branch` text,
	`provider_instance_id` text NOT NULL,
	`provider_session_id` text,
	`title` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`permission_mode` text NOT NULL,
	`state` text NOT NULL,
	`pinned` integer NOT NULL,
	`run_id` text,
	`step_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `threads_project_idx` ON `threads` (`project_id`);--> statement-breakpoint
CREATE TABLE `triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_item_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`run_at` text NOT NULL,
	`zone` text NOT NULL,
	`state` text NOT NULL,
	`run_id` text
);
--> statement-breakpoint
CREATE INDEX `triggers_due_idx` ON `triggers` (`state`,`run_at`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`index` integer NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`usage` text
);
--> statement-breakpoint
CREATE INDEX `turns_thread_idx` ON `turns` (`thread_id`,`index`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`calendar_item_id` text,
	`backlog_item_id` text,
	`state` text NOT NULL,
	`current_step` integer NOT NULL,
	`steps` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`template_kind` text,
	`steps` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
