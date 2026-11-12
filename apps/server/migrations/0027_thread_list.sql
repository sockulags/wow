ALTER TABLE `notifications` ADD `thread_id` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `approval_id` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `archived` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `seen` integer DEFAULT true NOT NULL;