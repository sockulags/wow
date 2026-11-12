ALTER TABLE `threads` ADD `state_since` text;--> statement-breakpoint
UPDATE `threads` SET `state_since` = `updated_at`;
