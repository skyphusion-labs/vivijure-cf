### fix(hygiene): install fetch timeout; ledger fake no longer wipes (cf#600, #555, #474)

`hInstallModule` now times out and retries the resident `/module.json` fetch
the same way core and the control plane do, instead of hanging. The storage
quota test fake throws on unknown SQL instead of clearing the ledger. Wan LoRA
preflight asks the planner registry whether a door is Wan LoRA instead of
hardcoding a cost-door name. SECURITY.md no longer ships a hand-typed
manifest count.
