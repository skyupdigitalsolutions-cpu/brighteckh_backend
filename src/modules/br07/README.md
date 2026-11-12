# BR-07 module — Material issue -> Repair -> Test -> Handoff -> Dispatch release

Schema: `db/migrations/009_br07_repair_test.sql` (+ `010` Prisma relation fix). See CLAUDE.md §4c.

Chain: Purchase issues a COMMITTED BR-05 reservation (MAIN_STORE -> ENGINEER_HELD,
ledger reservation closed as CONSUMED) -> engineer acknowledges material custody ->
time-tracked repair session -> versioned repair report (opens the test-start SLA clock,
due_at NULL until calendars are approved) -> test cycles (results immutable) -> Purchase
review required after 2+ failed cycles -> engineer technical handoff on a current PASS ->
Purchase dispatch release. Consumption (ENGINEER_HELD -> CONSUMED) and unused return
(ENGINEER_HELD -> MAIN_STORE after Purchase verify) all go through InventoryService.
