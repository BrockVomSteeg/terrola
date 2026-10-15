# Accessibility and speed

## What SPEC R13 asks, and why

SPEC R13: text contrast meets WCAG AA; Lighthouse accessibility and best practices score
at least 90 on the demo; performance scores at least 70 on the mobile preset; the reasons
are written here.

Why:

- People with disabilities should be able to use the map: people who use a keyboard, a
  screen reader, zoom or high contrast, and people who turn off motion.
- Most visits come from a phone, often on a slow network. The demo should open fast there,
  not only on a desktop with fibre.

## Where the checks run

Both automated layers run on the deployed demo at `https://terrola.vercel.app/map`, in
`.github/workflows/demo-quality.yml`. The map only draws with a Mapbox token, and the demo
token is locked to the demo address. A server started inside CI would show the setup
screen, not the map, so the checks would test the wrong page.

The workflow runs after each successful Production deployment, once a week, and by hand
(Actions, demo-quality, Run workflow). It uses no secrets. Reports are kept as run
artifacts for 7 days and are not uploaded anywhere else.

## Layer 1: axe in Playwright

`tests/e2e/a11y.spec.ts`, run with `npm run test:e2e` (config `playwright.e2e.config.ts`).

It runs [axe](https://github.com/dequelabs/axe-core) through `@axe-core/playwright` with the
rule tags `wcag2a`, `wcag2aa`, `wcag21a` and `wcag21aa`, on these screens:

- desktop: the map page on load, a place card opened from the list, the photo lightbox,
  and a place and its photo opened with the keyboard only (no axe scan, a focus check);
- phone sized (375 by 812): the map page on load, the list view, a place card opened from
  the list.

Each check waits until the screen has finished fading in, then fails on any violation.
Looping animations, such as a photo's loading shimmer, are not waited for, because they
never end.
Nothing is excluded today. If a violation ever comes from inside Mapbox's own map or
controls, which this project cannot change, only that node is excluded, by selector, with
a comment that says why.

What it catches: missing names on buttons and images, low text contrast, wrong ARIA,
missing page language, broken heading or list structure, and similar rules that a program
can decide.

What it misses: whether a name makes sense, whether the order of focus is logical, whether
everything works with a keyboard, whether a screen reader reads the screen in a useful
order, and anything inside the map canvas.

## Layer 2: Lighthouse CI

`lighthouserc.json`, run with `npm run lighthouse` (`@lhci/cli`).

- Mobile preset (the Lighthouse default): a phone sized screen with a simulated slow
  network and slow processor.
- 5 runs on `/map`; the median score of the 5 is judged.
- Accessibility at least 0.9 and best practices at least 0.9 fail the run when missed.
- Performance at least 0.7 is a warning for now, not a failure. Performance scores on
  shared CI machines move from run to run because the machine's speed and the network
  change. The median of 5 runs reduces that noise but does not remove it. Once the scores
  are steady over several weeks, this can become a failure.

What it misses: the accessibility score uses a subset of the same axe rules, on the page as
it first loads only, so it adds little over layer 1 there. Its value is in performance and
best practices (for example errors in the console, images shown at the wrong aspect ratio,
deprecated browser features).

## Automated tools catch about half

Automated checks find only part of the real problems:

- Deque's study of more than 2,000 audits (2021) found that automated tests with axe
  covered on average 57 percent of issues by volume. Counted by WCAG success criteria
  instead, the share often quoted is 20 to 30 percent:
  [Deque, automated testing study](https://www.deque.com/blog/automated-testing-study-identifies-57-percent-of-digital-accessibility-issues/).
- The GOV.UK audit put 142 known barriers on one page; the best single tool fully found
  40 percent of them:
  [GOV.UK accessibility tool audit](https://alphagov.github.io/accessibility-tool-audit/).

So a green run means no known automated failure, not that the site is accessible. The
manual checklist below covers the rest.

## The map itself

A map drawn on a canvas is a picture to a screen reader: the pins and labels on it cannot
be read out. The list of places is the way to reach every place without the map. Each place
in the list opens the same card as its pin.

Mapbox keyboard controls, when the map has keyboard focus:

- arrow keys pan;
- plus (or equals) zooms in, minus zooms out;
- shift with the left or right arrow rotates, shift with the up or down arrow tilts.

Each row in the list is a button: Tab reaches it, and Enter or Space opens the place card.
Each photo in a card works the same way and opens the lightbox. A ring shows which one has
keyboard focus. The test "keyboard opens a place and its photo" in `tests/e2e/a11y.spec.ts`
checks this path on the demo.

## Manual checklist before each release

Run on the deployed demo.

1. Keyboard only: Tab through the whole page. Every control can be reached, the focus ring
   is visible, the order makes sense, Escape closes the card and the lightbox, and focus
   is never trapped.
2. VoiceOver on iPhone: swipe through the page. Every button says what it does, the list
   reads each place, and a place card can be opened and closed.
3. VoiceOver on Mac (Command F5): the same, with the keyboard.
4. Zoom to 200 percent in the browser: nothing is cut off, text does not overlap, no
   sideways scrolling is needed for text.
5. Reduced motion (system setting on): the map and cards still work, and large movements
   are toned down or gone.
6. Light and dark system appearance: text stays readable in both.

Write down anything that fails as an issue before the release goes out.
