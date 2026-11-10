CREATE TABLE `plan_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`plan_id` text NOT NULL,
	`project_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`state` text NOT NULL,
	`units` text NOT NULL,
	`waiting_for` text NOT NULL,
	`message` text,
	`started_at` text NOT NULL,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `plan_runs_plan_idx` ON `plan_runs` (`plan_id`);--> statement-breakpoint
ALTER TABLE `workflow_runs` ADD `unit` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `for_units` integer DEFAULT false NOT NULL;