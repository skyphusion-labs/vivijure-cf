### Feat: the keyframe module offers the two-person pose figure (cf#1281)

The keyframe module (0.3.10) declares `pose_template`: `stand` (the default, the upright figure drawn before), `reach` (waist-up, the near arm forward, the head turned toward the partner) or `auto` (reach when the shot names a hand-off, a handshake or a shared surface). `stand` sends nothing, so a default render's request is unchanged. It needs vivijure-backend with `multi_char.pose_template` (vivijure-backend#649); an older backend ignores it.

The Make page test fixtures for cf-seedance and cf-hh1-r2v now carry their real manifests (`first_last: false`, seedance `face_hold: "one"`, cf#954). The rule tests that used seedance as their two-still door now use cf-vidu-q3-turbo or a named synthetic door, and assert that seedance is never picked.
