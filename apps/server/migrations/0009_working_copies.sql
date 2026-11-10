ALTER TABLE `workflow_runs` ADD `working_copy` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD `own_working_copy` integer DEFAULT false NOT NULL;