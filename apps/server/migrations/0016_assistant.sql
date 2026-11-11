CREATE TABLE `assistant_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`command_type` text NOT NULL,
	`what` text NOT NULL,
	`from` text,
	`to` text,
	`place` text NOT NULL,
	`target` text NOT NULL,
	`expect` text,
	`inverse` text NOT NULL,
	`state` text NOT NULL,
	`undone_at` text
);
--> statement-breakpoint
CREATE TABLE `assistant_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`command_type` text NOT NULL,
	`title` text NOT NULL,
	`lines` text NOT NULL,
	`place` text NOT NULL,
	`command` text NOT NULL,
	`state` text NOT NULL,
	`answered_at` text,
	`reason` text
);
