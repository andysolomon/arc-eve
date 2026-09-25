# Agent guidelines

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify
  complex features work. At the end of E2E tests, produce a verifiable and
  repeatable artifact.
- If you must test a system in isolation, first write down all the ways it
  could fail, then write the code.

The E2E suite is `test/e2e-acceptance.test.ts` (`pnpm test:e2e:fake`). It runs
the real `arc_delegate` tool against a fake runner and writes
`e2e-acceptance-evidence.json`, which is the artifact to check. See
[docs/architecture/e2e-acceptance.md](docs/architecture/e2e-acceptance.md).
