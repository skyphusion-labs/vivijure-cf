# How to make a film (hosted studio)

This page is for people using a hosted Vivijure Studio, not for people
installing one. Short words. One path.

## What you have

A web page that is your studio. You sign in. You make a film. The studio
talks to the GPUs. You do not open RunPod or Cloudflare.

## The path

1. **Project.** Open the studio. Start a project. Give it a name you will
   remember.
2. **Story.** Write what happens. The planner turns that into a
   storyboard: scenes, shots, and who is in them.
3. **Cast.** Add the people (or creatures) who appear. Give each one a
   still picture. If you train a look for a face, wait until that job
   finishes before you render.
4. **Audio (optional).** Add music, talking, or both. Talking doors
   either use the sample you kept (Seedance) or speak the line in the
   Cast voice (Wan / InfiniteTalk). Hosted does not add mouths in finish.
5. **Check.** Run preflight. Fix anything it flags (a clip that is too
   long, a missing picture, a door that is off).
6. **Render.** Pick a quality: draft (fast look), standard, or final
   (best, slower, costs more GPU time). Start the film. Leave the page
   open or come back; the job keeps running.
7. **Watch.** When it is done, download the movie. If a finish step
   could not run, the studio still ships the film and tells you what it
   skipped. That is a degrade, not a silent success.

## What the buttons mean

- **Draft / standard / final** is how hard the GPUs work, not a
  different story.
- **Finish** steps (smoother motion, sharper picture, lip-sync, color)
  run after the shots exist. Some run on every film. Some run only if
  you ask (color grade is ask-only).
- **Degraded** means the film shipped but a polish step passed the
  original through. Read the reason. You can try again.

## What this page is not

How to install the studio on your own machines. That is
[quickstart.md](quickstart.md). How the pieces fit together is
[constellation.md](constellation.md).
