-- The assistant thread is an ordinary main thread titled "Assistant", with its conversation and
-- provider session kept (orchestrator threads spec 25).
UPDATE `threads` SET `kind` = 'chat', `title` = 'Assistant' WHERE `kind` = 'assistant';
--> statement-breakpoint
-- Its instructions are now told to every main thread, after the provider's own.
INSERT OR REPLACE INTO `settings` (`key`, `scope`, `value`)
  SELECT 'chat.instructions', `scope`, `value` FROM `settings` WHERE `key` = 'assistant.instructions';
--> statement-breakpoint
-- The settings that chose its instance, model and effort went with its page, as did the keys of
-- the removed pages (spec 34).
DELETE FROM `settings` WHERE `key` IN (
  'assistant.providerInstanceId',
  'assistant.allowCodex',
  'assistant.model',
  'assistant.effort',
  'assistant.instructions',
  'keybindings.goPlans',
  'keybindings.goAssistant',
  'keybindings.gateApprove',
  'keybindings.gateSendBack',
  'keybindings.runChanges',
  'keybindings.runPath',
  'keybindings.ruleAdd',
  'keybindings.ruleMoveUp',
  'keybindings.ruleMoveDown',
  'keybindings.stopRun',
  'keybindings.threadsAtWork',
  'desktop.quickAskShortcut'
);
