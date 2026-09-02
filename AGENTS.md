# Kastard Agent Instructions

## Product and Architecture Guardrails

- Read and follow [`GUARDRAILS.md`](GUARDRAILS.md) before starting planning, implementation, or review.
- Check during the work and before completion that changes do not violate these guardrails.
- Use `GUARDRAILS.md` as the project standard when making product or architecture decisions.
- Do not hide or arbitrarily work around a user request or required change that conflicts or may conflict with a guardrail.
- Tell the user which guardrail conflicts, why it conflicts, the expected impact, and the available options.
- Proceed with work that conflicts with a guardrail only after receiving the user's explicit confirmation.

## Domain Terminology

- Use [`GLOSSARY.md`](GLOSSARY.md) as the standard when discussing product concepts in code, issues, plans, and conversations.
- Keep the glossary concise and limited to necessary information.
- Capture the essence of a term without copying incidental examples or secondary conditions supplied by the user.
- Add, modify, or remove glossary terms only when the user explicitly requests it.
- If code or documentation conflicts with the glossary, tell the user instead of changing the glossary unilaterally.

## External Links

- Use [`LINKS.jsonc`](LINKS.jsonc) as the canonical source for Kastard external destinations.
- Keep the entries listed in `LINKS.jsonc` consistent across code and documentation.
- Add, modify, or remove entries only when the user explicitly requests it.

## Implementation Principles

- Keep code and architecture as simple as possible while meeting the requirements.
- Do not add unnecessary layers, abstractions, wrappers, configuration, or extension points.
- Write comments only when they explain an important reason or constraint that is not evident from the code.
- Do not write comments that restate the code's behavior or repeat obvious information.
- Remove unnecessary, outdated, or misleading comments from directly related code while working on it.
- Do not remove license notices, security-critical explanations, or tool-required directives without authorization.
- Do not add to or modify `README.md`; the user intends to edit it later.

### Documentation Changes

- Do not create, modify, delete, translate, or reorganize documentation unless the user explicitly requests a documentation edit.
- Requests to inspect, discuss, review, plan, or answer questions about documentation do not authorize documentation changes.

### Renderer Component Structure

- `apps/desktop/src/renderer/src/components/ui/` contains shadcn/ui primitives.
- `apps/desktop/src/renderer/src/components/common/` contains reusable Kastard UI shared across features.
- Feature-specific components remain outside these folders and may evolve with their owning feature.

### ComfyUI Gateway Compatibility

- Treat the current ComfyUI frontend and backend behavior as the source of truth when the Gateway intercepts, adapts, or replaces ComfyUI traffic.
- Preserve the affected ComfyUI route's complete existing contract and user-visible behavior, not only the symptom that prompted a change. This includes supported methods, parameters, status codes, headers, streaming and range behavior, security rules, and downstream reuse of the same data.
- Prefer routing through ComfyUI's native routes and storage layout over reimplementing ComfyUI behavior in the Gateway. If interception is unavoidable, compare against the current ComfyUI implementation and add contract-level verification for the affected behavior.

### Final-State-Oriented Changes

- Code, identifiers, comments, product documentation, and tests changed directly by the work must describe the resulting current state and contract, not the process of changing them. Do not record renaming, implementation replacement, or refactoring instructions in the deliverables themselves.
- Tests must verify observable current behavior. Do not test for the absence of removed internal names, structures, or implementations unless that absence is part of a public contract or security requirement.
- Do not add tests whose only purpose is to assert that removed UI labels, elements, identifiers, or implementations are absent.
- When removing UI, delete obsolete display assertions and keep positive tests for the behavior that remains.
- Test absence only when it is an explicit product, security, accessibility, or compatibility requirement.
- Record change history in issues, PRs, commits, changelogs, ADRs, or migration documents. Preserve historical context that remains necessary for external compatibility, stored-data migration, security, or auditing, and explain why it remains and when it can be removed.
- Do not use this principle as authorization to delete existing records or compatibility code outside the current scope.
- Before completion, check whether the diff adds any code, comments, documentation, or tests solely to record that a change occurred.

## UI Interaction

- Temporary non-modal overlays such as popovers, dropdowns, and context menus must always close when the user clicks elsewhere.
- Guarantee the same behavior in areas such as iframes or separate documents where normal outside-interaction events do not reach the parent, without preventing the user's original click.

### Persisted Selection UI

- Use optimistic updates by default for non-destructive values that users change and persist, such as settings and synchronization selections. Reflect the interaction immediately, then restore the last confirmed value and show an error if persistence fails.
- Limit the saving state to the affected item. Do not disable or reduce the opacity of unrelated screens or controls unless data consistency requires it.
- Rapid changes to the same value must persist the final selection, and a late result from an earlier request must not overwrite the latest UI state.
- Do not use optimistic updates for operations whose success cannot be safely assumed, such as deletion, payment, or external transmission.
- Tests must cover immediate updates before persistence, restoration after persistence failure, and the final state after rapid successive changes.

## Build Number

- The user manages `buildNumber` manually. Agents must not change it in any task.
