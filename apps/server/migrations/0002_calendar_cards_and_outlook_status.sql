ALTER TABLE `calendar_items` ADD `all_day` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `outlook_status` ADD `unavailable_since` text;--> statement-breakpoint
ALTER TABLE `outlook_status` ADD `unread_count` integer DEFAULT 0 NOT NULL;