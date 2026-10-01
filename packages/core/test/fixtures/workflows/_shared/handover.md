Write the step handover for "{{step.name}}". The next step, possibly run by a different agent, starts from it, so make it accurate and specific. Do not narrate what you did step by step.

Reply with only a JSON object in a ```json block, in exactly this shape:

```json
{
  "goal": "What this step set out to do, in one or two sentences.",
  "decisions": [{ "decision": "What was decided", "why": "The reason" }],
  "rejected": [{ "option": "Alternative considered", "why": "Why not" }],
  "filesTouched": [{ "path": "src/example.ts", "why": "What changed and why" }],
  "verify": ["How the next person or agent can confirm this works"],
  "openQuestions": ["What is unresolved, and who should answer it"]
}
```

Limits: at most 7 decisions, 5 rejected options, 5 verify steps and 5 open questions; keep every entry under 300 characters. Use empty arrays when there is nothing to say. Only list files that actually changed.
