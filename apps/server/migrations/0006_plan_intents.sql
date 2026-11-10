CREATE TABLE `plan_intents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`intent_id` text NOT NULL,
	`title` text NOT NULL,
	`has_intent` integer NOT NULL,
	`status` text,
	`rev` integer,
	`spec` text,
	`plan` text,
	`source` text,
	`units` text NOT NULL,
	`problems` text NOT NULL
);
