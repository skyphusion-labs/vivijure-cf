### fix(render): the spoken-line gate counts only the shots being rendered

The talking-door check read every line in the board, so rendering only the silent shots of a board with dialogue was refused on a silent door. The panel door (`processShotIds`), the agent door (`scenes`) and finalize from keyframes (the picked keyframes) now count only the lines of the shots they make. If a rendered shot id is not in the bundle, every line still counts, so a voiced film is never sent silent on a guess. Explicit `dialogue_lines` are unchanged. Finalize's automatic door pick follows the same rule.
