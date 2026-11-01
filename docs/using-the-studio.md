# How to make a film (hosted studio)

This page is for people using a hosted Vivijure Studio, not for people
installing one. Short words. One path.

## What you have

A web page that is your studio. You sign in. You make a film. The studio
talks to the GPUs. You do not open RunPod or Cloudflare.

## The path

1. **Cast.** Add the people (or creatures) who appear. Give each one a
   still picture. A photoreal film also needs a trained look for each person:
   start it on Cast and wait until it finishes. An Anime film uses the picture.
   For an Anime film, design marks that read the same when mirrored, and make
   them bold. See
   [Flip-safe character design](../modules/cloud-keyframe/README.md#flip-safe-character-design).
2. **Plan.** Write what happens. The planner turns that into a
   storyboard: scenes, shots, and who is in them. A project name is under
   Advanced if you want one.
3. **Look.** On Render, choose Photoreal or Anime.
4. **Audio (optional).** Add music, talking, or both. Each talking door card
   says whether it speaks in the Cast voice or makes a voice from a
   description. Hosted does not add mouths in finish.
5. **Check.** Run preflight. Fix anything it flags (a clip that is too
   long, a missing picture, a door that is off).
6. **Render.** Pick a quality and a door. The studio shows the clip cost
   when the door states a rate, and asks before it starts. Leave the page
   open or come back to check on it.
7. **Watch.** When it is done, download the movie. If a finish step
   could not run, the studio still ships the film and tells you what it
   skipped. That is a degrade, not a silent success.

## What the buttons mean

- **Draft / standard / final** is how hard the GPUs work, not a
  different story.
- **Finish** steps (smoother motion, sharper picture, color)
  run after the shots exist. Some run on every film. Some run only if
  you ask (color grade is ask-only).
- **Degraded** means the film shipped but a polish step passed the
  original through. Read the reason. You can try again.

## What this page is not

How to install the studio on your own machines. That is
[quickstart.md](quickstart.md). How the pieces fit together is
[constellation.md](constellation.md).
