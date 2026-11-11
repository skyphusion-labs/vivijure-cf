### Fix: module install honours the studio's own script prefix

A studio whose plane sets `TENANT_MODULE_PREFIX` now installs only module scripts under that prefix, and answers any other `script_name` with `403` before the module namespace is read. Unset, as on self-host, any resident script installs as before.
