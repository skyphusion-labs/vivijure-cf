### fix(video-finish): keep apostrophes and colons in titles

A title with an apostrophe lost it, and one with a colon as well failed the render. Title, subtitle and credit text now goes to drawtext unquoted and escaped for both parsers, with `expansion=none`. Needs a container deploy.
