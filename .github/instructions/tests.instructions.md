---
applyTo: "tests/**"
---

# Test engineering requirements

- Derive tests from observable acceptance criteria, not implementation details.
- Add regression tests that fail on the old behavior.
- Cover refusal paths, missing/invalid input, boundary values, replay, concurrency and partial failure where applicable.
- Use isolated PGlite tests with `DATABASE_URL` and `DATABASE_URL_UNPOOLED` unset; do not point the standard suite at production Neon.
- Report exact command, pass/fail counts and skipped checks. Never claim a test passed if it was not run.
- For money, authorization, key, tool and SSRF paths, test the negative/refusal behavior as well as success.
