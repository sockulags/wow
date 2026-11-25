-- Workflow runs, plan runs, plans, the host poller's reads and event triggers are gone
-- (orchestrator threads spec 35). Step threads stay as ordinary threads, marked done.
UPDATE `threads` SET `state` = 'done' WHERE `run_id` IS NOT NULL AND `state` != 'done';
--> statement-breakpoint
-- A step thread of a run with its own working copy worked in that copy, which nothing settles or
-- removes any more and which an event run may have left at a fork's head. As an ordinary thread
-- it would offer Commit and push there, which run the repository's hooks (thread work Security),
-- so it moves to its project's folder and starts a new session there.
UPDATE `threads` SET
  `cwd` = (SELECT `projects`.`cwd` FROM `projects` WHERE `projects`.`id` = `threads`.`project_id`),
  `provider_session_id` = NULL
  WHERE `run_id` IN (SELECT `id` FROM `workflow_runs` WHERE `working_copy` IS NOT NULL)
    AND `project_id` IN (SELECT `id` FROM `projects`);
--> statement-breakpoint
-- A card or backlog item that followed a run that is now gone no longer waits for it.
UPDATE `calendar_items` SET `state` = 'stopped'
  WHERE `run_id` IS NOT NULL AND `thread_id` IS NULL AND `state` IN ('running', 'waiting');
--> statement-breakpoint
UPDATE `backlog_items` SET `state` = 'planned' WHERE `run_id` IS NOT NULL AND `state` = 'running';
--> statement-breakpoint
-- What the app said about runs and plan runs leads to pages that are gone.
DELETE FROM `notifications` WHERE `run_id` IS NOT NULL;
--> statement-breakpoint
-- The event triggers' rows go with the table below; the events that made them go here, so the
-- store holds nothing of what was removed.
DELETE FROM `events` WHERE `kind` IN (
  'workflowRun.changed',
  'planRun.changed',
  'plans.synced',
  'hosts.synced',
  'tickets.synced',
  'pages.synced',
  'trigger.eventSeen'
);
--> statement-breakpoint
DELETE FROM `events` WHERE `kind` = 'trigger.set' AND json_extract(`payload`, '$.kind') = 'event';
--> statement-breakpoint
-- A card's trigger is `<cardId>:trigger`; an event trigger's id never had a colon.
DELETE FROM `events` WHERE `kind` = 'trigger.deleted' AND `aggregate` NOT LIKE '%:trigger';
--> statement-breakpoint
-- The assistant's changes and proposals of the removed commands can no longer be undone or
-- accepted.
DELETE FROM `assistant_changes` WHERE `command_type` IN (
  'workflowRun.start',
  'workflowRun.continue',
  'workflowRun.stop',
  'workflowRun.sendBack',
  'plan.follow',
  'planRun.start',
  'planRun.stop',
  'trigger.create',
  'trigger.setEnabled',
  'trigger.delete',
  'thread.retry'
);
--> statement-breakpoint
DELETE FROM `assistant_proposals` WHERE `command_type` IN (
  'workflowRun.start',
  'workflowRun.continue',
  'workflowRun.stop',
  'workflowRun.sendBack',
  'plan.follow',
  'planRun.start',
  'planRun.stop',
  'trigger.create',
  'trigger.setEnabled',
  'trigger.delete',
  'thread.retry'
);
--> statement-breakpoint
-- "Run now" names the thread it starts instead of a run.
UPDATE `assistant_proposals`
  SET `command` = json_set(json_remove(`command`, '$.runId'), '$.threadId', json_extract(`command`, '$.runId'))
  WHERE `command_type` = 'card.runNow' AND json_extract(`command`, '$.runId') IS NOT NULL;
--> statement-breakpoint
-- The decision queue's rows about runs.
DELETE FROM `decision_briefs`
  WHERE `decision_id` LIKE 'failedRun:%' OR `decision_id` LIKE 'gate:%' OR `decision_id` LIKE 'limit:%';
--> statement-breakpoint
DELETE FROM `decision_dismissals`
  WHERE `decision_id` LIKE 'failedRun:%' OR `decision_id` LIKE 'gate:%' OR `decision_id` LIKE 'limit:%';
--> statement-breakpoint
-- The settings only runs, plans and the host poller read.
DELETE FROM `settings` WHERE `key` IN (
  'workflows.handoverTemplate',
  'workflows.sendBackTemplate',
  'workflows.goBackTemplate',
  'workflows.unitPromptTemplate',
  'workflows.planRunOnFailure',
  'workflows.planRunParallel',
  'workflows.attachBuiltInSkills',
  'workflows.gateChecksTimeoutMinutes',
  'workflows.maxStepVisits',
  'workflows.templates',
  'plans.intentsDirectory',
  'plans.writeSettleMs',
  'hosts.polling',
  'hosts.pollSeconds',
  'hosts.listFallbackCount',
  'assistant.readMaxDiffLines',
  'appearance.changesListWidth'
);
--> statement-breakpoint
DROP TABLE `change_requests`;--> statement-breakpoint
DROP TABLE `host_reads`;--> statement-breakpoint
DROP TABLE `page_reads`;--> statement-breakpoint
DROP TABLE `plan_intents`;--> statement-breakpoint
DROP TABLE `plan_runs`;--> statement-breakpoint
DROP TABLE `ticket_reads`;--> statement-breakpoint
DROP TABLE `trigger_events`;--> statement-breakpoint
DROP TABLE `workflow_runs`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`calendar_item_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`run_at` text NOT NULL,
	`zone` text NOT NULL,
	`state` text NOT NULL,
	`offer_run_now` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_triggers`("id", "calendar_item_id", "workflow_id", "run_at", "zone", "state", "offer_run_now") SELECT "id", "calendar_item_id", "workflow_id", "run_at", "zone", "state", "offer_run_now" FROM `triggers` WHERE `kind` = 'card' AND `calendar_item_id` IS NOT NULL AND `run_at` IS NOT NULL AND `zone` IS NOT NULL AND `state` IS NOT NULL;--> statement-breakpoint
DROP TABLE `triggers`;--> statement-breakpoint
ALTER TABLE `__new_triggers` RENAME TO `triggers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `triggers_due_idx` ON `triggers` (`state`,`run_at`);--> statement-breakpoint
CREATE INDEX `triggers_card_idx` ON `triggers` (`calendar_item_id`);--> statement-breakpoint
ALTER TABLE `backlog_items` DROP COLUMN `run_id`;--> statement-breakpoint
ALTER TABLE `calendar_items` DROP COLUMN `run_id`;--> statement-breakpoint
ALTER TABLE `card_occurrences` DROP COLUMN `run_id`;--> statement-breakpoint
ALTER TABLE `notifications` DROP COLUMN `run_id`;--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `run_id`;--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `step_id`;