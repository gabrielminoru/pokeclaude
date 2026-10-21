# AGENT.md

How to open a pull request on this repository.

## Before you start

- Read the issue you are implementing and the code around it. Every caller, test, fixture and export your change touches is in scope.
- Run the tests: `claude plugin test`. Every test must pass before you open the PR.
- Validate the plugin: `claude plugin validate .`.

## Commits

- Conventional Commits, always in English.
- `feat:` a new capability, `fix:` a bug, `docs:` documentation, `refactor:` a change of shape, `test:` tests, `chore:` the rest.
- A scope is welcome: `feat(pokemon): show base stats on the card`.
- The subject is imperative and in the present tense: "add base stats to the card", never "added" or "adds".
- One commit per concern. A refactor and the feature it carries are two commits.

## Pull requests

- The title follows Conventional Commits, in English, in the same form as a commit: `feat(pokemon): show base stats on the card`.
- The body is in English.
- The body explains what changed and why. Link the issue it closes with `Closes #<number>`.
- **Never add a co-author trailer** (`Co-authored-by:`, `Co-Authored-By:`). A PR carries its author's attribution on its own.
- Assign `rodrigomcoelho` and add the `ready for review` label, when the repository lets you.

## The code

- No comments in the code. A name says what a thing is; a comment that says what it is belongs in the name.
- Keep the structure the repository already has: `hooks/pokeapi.ts` for PokeAPI, `hooks/rules.ts` for the pure rules, `hooks/register.tsx` for the hooks and the drawing, `types/index.d.ts` for the shared types.
- The pure rules take their randomness and their clock as arguments, so a test can pin them. A rule that reads the clock or draws a number on its own is a rule that cannot be tested.
- Every new branch, parser or loop leaves a test. Run the suite before you push.
- A shortcut with a known limit carries `shortcut: <the limit>, <when to upgrade>`.
