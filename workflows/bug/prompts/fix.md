Fix this bug. The reproducing test from the previous step must pass, and nothing else may break.

{{card.key}}: {{card.title}}

{{handover.previous}}

{{#if docs.relevant}}
Relevant product documentation (may be out of date — the code is the truth):

{{docs.relevant}}
{{/if}}

Guidelines:
- Fix the root cause, not the symptom. Keep the change as small as the fix allows.
- Don't refactor unrelated code or reformat files.
{{#if repo.checks}}- Before you finish, run the checks yourself: `{{repo.checks}}`{{/if}}
- Explain the root cause in one or two sentences when you are done.
