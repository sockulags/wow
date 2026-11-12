ALTER TABLE `threads` ADD `go_back` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `forked_from` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `resume_point` text;--> statement-breakpoint
ALTER TABLE `turns` ADD `replaced_by` text;