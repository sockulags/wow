# @wow/workflow-engine

Pure workflow run state machine. `startRun` and `advance` take a workflow, a run and an input
(step completed, step failed, Continue, Stop, artifacts found) and return the next run plus the
effects the server performs (start a step's thread with its prompt, interrupt, set a thread's
state, notify). `renderHandover` renders the `workflows.handoverTemplate` setting and
`missedTriggerOutcome` maps the missed-trigger policy. No I/O.
