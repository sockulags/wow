-- The assistant's briefings, its decision queue, its delegation under standing permissions and its
-- notes are gone (orchestrator threads spec 35, intent decision log 2026-11-23). A thread the
-- assistant started stays as an ordinary chat thread.
UPDATE `threads` SET `started_by` = NULL WHERE `started_by` = 'assistant';
--> statement-breakpoint
DELETE FROM `notifications` WHERE `kind` IN ('briefing', 'reminder');
--> statement-breakpoint
-- Events are never replayed; the ones of the removed kinds go, so they cannot be read back.
DELETE FROM `events` WHERE `kind` IN (
  'decision.briefRequested',
  'decision.briefWritten',
  'decision.dismissed',
  'decision.reminded',
  'briefing.made',
  'briefing.summaryWritten',
  'briefing.notified',
  'presence.returned',
  'thread.delegated',
  'thread.followed',
  'question.answeredByAssistant',
  'assistant.permissionUsed'
);
--> statement-breakpoint
DELETE FROM `events`
  WHERE `kind` = 'notification.sent' AND json_extract(`payload`, '$.kind') IN ('briefing', 'reminder');
--> statement-breakpoint
-- The assistant's changes and proposals of a setting that is gone could no longer be undone or
-- accepted: the ones removed here, and the ones 0051 removed, whose records it left.
DELETE FROM `assistant_changes`
  WHERE json_extract(`target`, '$.kind') = 'setting'
    AND substr(json_extract(`target`, '$.id'), 1, instr(json_extract(`target`, '$.id'), ':') - 1) IN (
    'assistant.delegation',
    'assistant.permissions',
    'assistant.followTurns',
    'assistant.maxDelegatedLive',
    'assistant.briefsPerDay',
    'assistant.briefings',
    'assistant.briefingsPerDay',
    'assistant.briefAfterMeetingMinutes',
    'assistant.briefAfterIdleMinutes',
    'assistant.remindAfterMinutes',
    'assistant.notes',
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
DELETE FROM `assistant_proposals`
  WHERE `command_type` IN ('setting.set', 'setting.reset') AND json_extract(`command`, '$.key') IN (
    'assistant.delegation',
    'assistant.permissions',
    'assistant.followTurns',
    'assistant.maxDelegatedLive',
    'assistant.briefsPerDay',
    'assistant.briefings',
    'assistant.briefingsPerDay',
    'assistant.briefAfterMeetingMinutes',
    'assistant.briefAfterIdleMinutes',
    'assistant.remindAfterMinutes',
    'assistant.notes',
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
-- The removed settings.
DELETE FROM `settings` WHERE `key` IN (
  'assistant.delegation',
  'assistant.permissions',
  'assistant.followTurns',
  'assistant.maxDelegatedLive',
  'assistant.briefsPerDay',
  'assistant.briefings',
  'assistant.briefingsPerDay',
  'assistant.briefAfterMeetingMinutes',
  'assistant.briefAfterIdleMinutes',
  'assistant.remindAfterMinutes',
  'assistant.notes'
);
--> statement-breakpoint
DROP TABLE `assistant_permission_uses`;
--> statement-breakpoint
DROP TABLE `briefings`;
--> statement-breakpoint
DROP TABLE `decision_briefs`;
--> statement-breakpoint
DROP TABLE `decision_dismissals`;
--> statement-breakpoint
DROP TABLE `decision_reminders`;
--> statement-breakpoint
ALTER TABLE `questions` DROP COLUMN `answered_because`;
--> statement-breakpoint
ALTER TABLE `threads` DROP COLUMN `follow_turns`;
