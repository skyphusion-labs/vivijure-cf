### Fix: a running finish job keeps its container awake, and a finished job's answer survives the container (#784)

`/async/finish` returns at once, so nothing renewed the finish container's idle timer while an encode ran. A job that outlived it was put to sleep under itself. The container's job state is also process memory, so a finished job's answer died with a restart or sleep, and core saw `not_found`.

- When the idle timer runs out, the Durable Object asks the container about each job it saw accepted and not yet finish. While one is still pending, or the probe cannot tell, it keeps the instance awake. A hold ends at core's phase deadline (90 minutes).
- Every terminal status the Durable Object sees, from core's poll or from its own probe, is recorded in Durable Object storage for an hour. A later status read carrying the container's bearer is answered from the record without reaching the container, marked `recorded: true`.
- No module contract or core input changes. A job still running when the container process dies is still lost, and core re-submits as before.
