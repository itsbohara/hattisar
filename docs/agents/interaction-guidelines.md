# Agent Interaction Guidelines

Rules for how agents should respond to user requests, distinguishing between planning, discussion, and implementation phases.

---

## Implementation Plans

When the user asks for a "plan", "proper plan", or similar:

**Include:** what to build (spec-level), file paths to create/modify, data shapes as prose/tables, API request/response fields as prose/tables, sequencing & dependencies, decision rationale where non-obvious.

**Do not include:** actual code blocks, SQL/Prisma model bodies, TypeScript/Python/JSX/any language code, or pseudocode that is essentially real code with syntax removed.

Plans describe _what_ to build and _why_, not _how_ to write every line.

---

## Documentation Style

Explain concepts and architecture ("why"), don't duplicate code. Small snippets (2–5 lines) only when essential. Reference file paths instead of copying implementations.

---

## Ask Mode

When the user is exploring/asking (not requesting implementation), respond with structured text: ASCII diagrams, markdown tables, decision matrices, bullets and prose. No code snippets unless explicitly requested.

Triggers: "What do you think about...", "How would you approach...", "I'm exploring...", "Can you explain...".

---

## Implementation Mode

Only switch to Implementation Mode when the user explicitly says "build", "write", "create", "implement", or similar. Then code may be written to files. When in doubt, stay in Ask/Plan mode and confirm.
