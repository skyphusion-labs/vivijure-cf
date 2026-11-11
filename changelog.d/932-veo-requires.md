### Feat: cf-veo's 1080p limit is refused when the film starts (cf#932, core#507)

cf-veo 0.1.5 declares `requires: [{ when: "1080p", shot_seconds: { min: 7.5 } }]` on `resolution`, so core 1.45+ refuses a 1080p film with a shot that will not be an 8 second clip when the film starts, before keyframes are bought. Before, cf-veo refused it at clip time. The bound is 7.5 planned seconds because cf-veo rounds 7.5 s and up to an 8 s clip. The module keeps its own check at invoke. A test holds the two equal for every length on a grid.
