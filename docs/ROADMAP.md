# Roadmap

Ideas for later, not promises, and no dates. Each one would ship the way everything here
ships: its own pull request, tests first, CI, and an independent review.

## Trip memories from your photos

Add the photos from a trip and Terrola puts the trip together for you.

- It reads what each photo already knows (when and where it was taken, the camera, the
  direction it faced) together with the notes and short answers you type.
- From that it works out where you were and what you were doing, and writes a short summary,
  a breakdown and a day by day itinerary of the trip. You can edit all of it.
- Each step is a small, cheap model whose answer must match a fixed, typed shape before it is
  used, so a bad guess is rejected instead of saved.
- Privacy first. Today the browser redraws every photo before upload, which removes its
  location and camera data on purpose (`components/Map/AdminPanel.tsx`). This feature would
  read that data first, keep it only in your private trip record, and let you turn it off or
  delete it at any time.
- It runs only on your own copy with your own keys. The public demo stays read only.

## Many maps

Each map is shared with its own group of people, who can all add to it. One person can be in
several maps with different people. A new map with new memories also needs its own backups.

## Already deferred

Accounts per user, weather and tide facts, illustrated scenes and native apps: see
"Refused or deferred" in the [README](../README.md#refused-or-deferred).
