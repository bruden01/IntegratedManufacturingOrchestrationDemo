# 4. Finishing the damaged seat across all systems (demo step 5)

## Why this needs review
The feedback asks that the damaged-seat scenario show orchestration across the plant MES, two supplier databases, OPC UA machine data and the tugger system. Today the flow uses the plant MES (to look up the seat spec) and Supplier A's database (reserve the spare). Supplier B's database and the tuggers only feed the board display, and OPC UA is not involved. The user said this scenario needs to be finished.

## What exists now
See the shared README for the full flow. The steps today, in the Behind the scenes panel: Supplier A vision check fails, Supplier A places the hold, Vantiq reserves a spare, the warehouse picker takes it, the hold is released and Vantiq closes the case.
- Supplier B: `Databases/schema/supplier_b.sql` has `tuggers(id, model, capacity, state, fault_code)` and `assignments(seq, tugger_id)`. The `SupplierBDB` source is a JDBC source (read and write path proven for Supplier A; untested for Supplier B).
- OPC UA: the `SupplierBMachines` source monitors `Machine.CHG-1..3.{State,ChargePct,FaultCode}` and `Machine.CONV-1.{State,CartCount,FaultCode}`; the `Machines` service normalizes them.

## Proposal to review
After the spare is picked (or at the point the replacement is ready to move), add steps where Vantiq:
1. **Checks the tuggers.** Reads tugger state from Supplier B's database and the charger state and charge level over OPC UA, to find a healthy tugger with a charged charger.
2. **Assigns.** Writes the replacement's assignment into Supplier B's `assignments` table (a request into the supplier's own table, as with the reservation).
3. **Supplier B acts.** The simulator's tugger honors the assignment and the seat set goes ON_TUGGER on that tugger.
4. **Reports.** New steps in the case record and the log (for example "Vantiq checked T1 and its charger CHG-1", "Vantiq assigned the replacement to T1").
5. **Buffer.** The hold and replacement delay the seat set; the buffer (item 2) reflects it and the script's "held the line-side time" claim becomes visible.

## Decisions needed from you
Answer each one by filling in the line under it (a one-word answer or "go with your recommendation" is fine). A fresh session should not build until these are answered.

1. **Depth of the tugger and OPC UA part.** Options: (a) read tugger and charger state and report it only, (b) also assign the replacement to a tugger by writing Supplier B's `assignments` table. Recommendation: (b), since it shows all five systems acting.
   Your answer:
2. **How the simulator handles an assignment.** Today a vehicle's tugger comes from a fixed cycle. OK for the simulator to read `assignments` and use it? Recommendation: yes.
   Your answer:
3. **Order of the new steps** relative to the pick and the hold release. Recommendation: after the pick and before the release, so the release means the replacement is on its way.
   Your answer:
4. **The no-spare branch.** Options: (a) it keeps ending at "needs a person to decide" for now, (b) build the decision screen as part of this item. Recommendation: (a) now, (b) as its own item later.
   Your answer:
5. **Which vehicle is damaged.** Always the one at position 4, or vary? Recommendation: keep it fixed so the script is repeatable.
   Your answer:

## Done when
A damaged-seat run shows steps touching plant MES, Supplier A, Supplier B and OPC UA, each attributed to who did it, ending with the replacement on a named tugger and the case closed.
