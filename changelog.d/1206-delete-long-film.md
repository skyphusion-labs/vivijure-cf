### feat(film): delete a film built as parts

`DELETE /api/film/:id` removes a long film as a whole: each part's renders through the same reclaim the render delete uses, every joined version and its captions, and the film's own records, the doc last so a delete that stops part way can be run again. Anything a surviving render still uses stays. It refuses while a part renders, a join is out or a new still is being drawn, and stops a film that could still start a part before anything goes. The film page has a "Delete this film" button that asks first and says plainly that it cannot be undone.
