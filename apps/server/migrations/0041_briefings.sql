CREATE TABLE `briefings` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`moment` text NOT NULL,
	`since` text NOT NULL,
	`lines` text NOT NULL,
	`summary` text,
	`summary_pending` integer DEFAULT false NOT NULL,
	`notified` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decision_reminders` (
	`decision_id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL
);
