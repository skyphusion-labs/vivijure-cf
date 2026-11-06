### feat(panel): the scene editor shows a long board 50 scenes at a time

A board may hold 600 scenes. The scene editor built a row for every scene, and 600 rows are 22,712 DOM nodes. Now, on a board of more than 50 scenes, it shows one window of 50, with a pager above and below the list ("Scenes 51 to 100 of 600", previous, next, and go to scene). A board of 50 or fewer shows every row and no pager, as before. 50 is the most the planner writes in one turn (core `PLANNER_ASK_MAX_SCENES`), and a test holds the two equal. Edits still change the storyboard in place. A delete keeps the window it was made in, and a new plan opens at scene 1. Measured in real Chrome at 390 px with the CPU throttled 4x (`tests/browser/scene-editor-600.mjs`, now part of `npm run test:browser`), on a quiet box:

| | 600 rows before | one window now |
| --- | --- | --- |
| load | 0.7 to 0.8 s | about 0.2 s |
| delete | 0.83 to 0.88 s | about 0.16 s |
| key to the next frame | 31 to 34 ms | 17 to 20 ms |

Under load on the same box, all 600 rows measured 317 ms per key and 3.9 s per delete. The panel still has no storyboard import, and refine cannot grow a board past 50 yet (cf#1334, vivijure-core#473), so the editor does not point to either.
