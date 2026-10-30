### fix(finish): title cards and captions are sized for a vertical frame (#1111)

On a vertical film the title ran off both sides of the card, and one line of dialogue wrapped to six lines across the speaker. Cards now scale by the frame's short side, and captions by its aspect against 16:9. At 720x1280 a title is 53px, and that line of dialogue is two lines. A frame at least as wide as it is tall keeps its sizes. A title too long for the card wraps to at most three lines and shrinks, on any frame, so a landscape title that ran off the edge now stays on.
