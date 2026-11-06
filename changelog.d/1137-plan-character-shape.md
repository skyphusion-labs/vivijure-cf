### fix(plan): a characters entry without slot is a 400, not a 500

`POST /api/storyboard/plan` checked only that `characters` was an array, so an entry with no `slot` made the planner prompt builder throw and the route answered 500 "internal error". Each entry must now be `{ slot, name, bible }`: `slot` one of A to D and used once, `name` a non-empty string, `bible` a string that may be empty. Anything else is a 400 that names the entry and the bad fields (vivijure-cf#1137). The MCP tool description is tracked in vivijure-mcp#85.
