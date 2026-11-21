ALTER TABLE `questions` ADD `answered_because` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `started_by` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `follow_turns` integer DEFAULT 0 NOT NULL;