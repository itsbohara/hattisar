# Kickoff prompt

Paste in a fresh agent session from inside this repo.

---

Read `AGENTS.md`, `docs/design.md`, `GOAL.md`, `TASK.md` and `docs/plans/v1.md`. Check
`git log` and `.superpowers/sdd/` for progress — resume at the first plan task without a completion
line in the ledger; never redo completed tasks. Execute with subagent-driven development: Opus for
implementers, Sonnet for task reviews, Opus for the final review. Subagents never commit; commit by
layer after each reviewed task. Keep the hard invariants in `AGENTS.md`.
