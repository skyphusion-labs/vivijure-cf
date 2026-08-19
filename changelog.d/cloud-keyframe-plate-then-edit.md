### fix(cloud-keyframe): plate then edit; stop portrait borrows

Workers AI nano-banana-2 now renders a text-only scene plate, then
edits faces into that plate. Empty-slot shots stay text-only. Both
sites that copied a grey portrait onto empty refs are gone. Default
`film_ref` is `first_keyframe` so shot 1 (the plate) is the film-wide
scene lock. The plate sidecar is not the delivered character keyframe.
Module 0.1.8.
