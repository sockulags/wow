CREATE TABLE `assistant_permission_uses` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`permission_id` text NOT NULL,
	`kind` text NOT NULL,
	`command_type` text NOT NULL,
	`what` text NOT NULL,
	`place` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `assistant_permission_uses_at_idx` ON `assistant_permission_uses` (`permission_id`,`at`);