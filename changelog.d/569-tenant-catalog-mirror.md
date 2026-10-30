### fix(catalog): the tenant catalog mirror drops the retired doors

`seedance`, `google-veo` and `vidu-q3` leave `scripts/tenant-module-catalog.txt`, matching `TENANT_MODULE_CATALOG` in the control plane (cp#569). The mirror goes from 16 entries to 13.
