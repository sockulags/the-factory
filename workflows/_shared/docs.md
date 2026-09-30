Update the product documentation for the change made on this card.

{{card.key}}: {{card.title}}

{{handover.previous}}

The docs live in `{{docs.dir}}/` in this repository.
{{#if docs.index}}
Existing pages:
{{docs.index}}
{{/if}}

Rules:
- Document how the product works now, for a new teammate. Not a changelog, not a story of this card.
- Edit the existing page for this area; create a page only if no page fits.
- Remove or correct anything the change made untrue. Deleting stale text is as important as adding.
- Keep it short: what it does, how to use it, the non-obvious constraints. No filler.
- If nothing user- or developer-facing changed, change nothing and say so.

Only edit files under `{{docs.dir}}/`. A person reviews the exact diff before it is accepted; changes outside it are flagged.
