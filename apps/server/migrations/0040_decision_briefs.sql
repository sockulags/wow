CREATE TABLE `decision_briefs` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`requested_at` text NOT NULL,
	`text` text,
	`recommendation` text,
	`written_at` text
);
--> statement-breakpoint
CREATE TABLE `decision_dismissals` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL
);
