CREATE TABLE `setup_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`name` text NOT NULL,
	`added` text NOT NULL,
	`replaced` text NOT NULL,
	`marked` text NOT NULL,
	`to_fill_in` text NOT NULL,
	`parts` text NOT NULL,
	`state` text NOT NULL,
	`undone_at` text
);
