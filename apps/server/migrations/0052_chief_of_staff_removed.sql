-- The assistant's briefings, its decision queue, its delegation under standing permissions and its
-- notes are gone (orchestrator threads spec 35, intent decision log 2026-11-23). A thread the
-- assistant started stays as an ordinary chat thread.
UPDATE `threads` SET `started_by` = NULL WHERE `started_by` = 'assistant';
--> statement-breakpoint
DELETE FROM `notifications` WHERE `kind` IN ('briefing', 'reminder');
--> statement-breakpoint
-- Events are never replayed; the ones of the removed kinds go so the store holds nothing of them.
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
-- The removed settings, with the assistant's changes and proposals of them, which could no longer
-- be undone or accepted.
DELETE FROM `assistant_changes`
  WHERE json_extract(`target`, '$.kind') = 'setting' AND (
    json_extract(`target`, '$.id') LIKE 'assistant.delegation:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.permissions:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.followTurns:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.maxDelegatedLive:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.briefsPerDay:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.briefings:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.briefingsPerDay:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.briefAfterMeetingMinutes:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.briefAfterIdleMinutes:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.remindAfterMinutes:%' OR
    json_extract(`target`, '$.id') LIKE 'assistant.notes:%'
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
    'assistant.notes'
  );
--> statement-breakpoint
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
