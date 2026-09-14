# Parent provider foundation

- [x] #9 Configure and authenticate the Eve parent provider
- [x] Direct parent-provider routing when EVE_PARENT_BASE_URL is set

# Worker identity and operator auth surface

- [x] #12 Share ARC Pi worker binary resolution with ARC runner
- [x] #10 Provide an operator-only worker login/status surface in Eve
- [x] #11 Match ARC Pi provider login lifecycle and secrecy guarantees

# End-to-end acceptance

- [x] #13 Add an end-to-end provider-backed Eve acceptance test

Recommended order: #9 → #12 → #10/#11 (parallel after #12) → #13.
Issue #4 remains closed as the v1 host-only adapter; these are the parity
follow-ups.
