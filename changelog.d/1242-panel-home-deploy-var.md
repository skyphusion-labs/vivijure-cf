### feat(deploy): set PANEL_HOME from the deploy env

`PANEL_HOME` can now be set at deploy time like `AUTH_MODE`: put `PANEL_HOME=simple` in `deploy.env` (or the `PANEL_HOME` repository variable for the CI deploy) to open the studio on the Make a video page. Leave it blank to keep the planner home; that is the default, so existing deployments do not change.
