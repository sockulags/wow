// Event colors for the time grid (audit B-11), set on the grid's root element. They stay next to
// the calendar until the shared tokens in styles/tokens.css take them over; nothing outside the
// calendar uses them. Block borders keep at least 3:1 against the page and the work-hours band in
// both themes, and the band stays lighter than both kinds of block.
export const eventTokens = [
  '[--event-outlook:oklch(0.93_0.035_250)]',
  '[--event-outlook-border:oklch(0.6_0.09_250)]',
  '[--event-card:oklch(1_0_0)]',
  '[--event-card-border:oklch(0.62_0_0)]',
  '[--event-work-hours:oklch(0.965_0.006_250)]',
  '[--event-now:var(--state-failed)]',
  'dark:[--event-outlook:oklch(0.29_0.045_250)]',
  'dark:[--event-outlook-border:oklch(0.58_0.08_250)]',
  'dark:[--event-card:oklch(0.22_0_0)]',
  'dark:[--event-card-border:oklch(0.56_0_0)]',
  'dark:[--event-work-hours:oklch(1_0_0/3.5%)]',
].join(' ');
