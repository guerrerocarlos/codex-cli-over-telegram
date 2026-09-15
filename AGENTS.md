# Repository Instructions

These instructions apply to the whole repository.

## Completion Policy

- Commit task changes when the task is complete and verification has passed.
- Push the completion commit to GitHub after committing.
- Do not commit or push while working in plan mode.
- Do not include unrelated user changes in a completion commit. If unrelated files are dirty, leave them alone and commit only the files touched for the task.
- If verification cannot be run, commit only when the user explicitly accepts that risk, and mention the skipped verification in the final response.

## Working Notes

- Keep documentation current when behavior, setup, deployment, or operational expectations change.
- Prefer small, focused commits with clear messages.
- Before committing, inspect `git status --short` and the relevant diff.
- After pushing, report the commit hash and branch.
