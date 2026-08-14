### ci(deploy): the deploy gate now waits on container-tests and migrations-gate (cf#526 follow-up)

`deploy` needed `[ci, assert-on-main]`. `container-tests` and `migrations-gate` both RUN on a tag push
-- neither carries an `if:`, so the workflow's `tags: ["v*"]` trigger starts them -- and neither was in
that list, so a tag could deploy to production with either one RED and nothing would report it. The
deploy job simply never looked. `migrations-gate` is the urgent half: it guards SCHEMA, and a deploy
that ships a worker whose migrations gate failed is the shape where the code arrives and the database
it expects does not. Adding them cannot deadlock, because both run unconditionally on this trigger.
