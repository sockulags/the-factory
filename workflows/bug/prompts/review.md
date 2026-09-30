Review the fix for this bug. You are read-only: do not change files.

{{card.key}}: {{card.title}}

{{handover.previous}}

Look at the changes on this branch (`git diff {{repo.base}}...HEAD` and uncommitted changes with `git diff`). Check:
1. Does it fix the root cause described, and does the test prove it?
2. Correctness: edge cases, error handling, concurrency, data migrations.
3. Anything that could break for other callers.
4. Unnecessary changes that should be reverted.

End with a verdict: **approve** or **request changes**, and list the concrete changes you'd require, most important first. Skip style nits unless they hide a bug.
