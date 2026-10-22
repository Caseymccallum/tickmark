/**
 * The whole look, in one module.
 *
 * Kept apart from `views.js` on purpose: that file decides what a page *says*, this one decides how
 * it looks, and neither is easier to change because the other is tangled into it. It has no
 * dependencies and no build step, which is a product decision rather than a stylistic one — a
 * practice runs this on their own machine, and every dependency is something they must install,
 * trust and update. The sheet is inlined into each page, so it costs one request and can never 404.
 *
 * Where the ideas come from: Cal.com for the shadow-first monochrome and multi-layer elevation,
 * Stripe for tabular numerals and depth tinted with the ink rather than with black, Wise for the
 * single friendly green. Everything chromatic in here is a *state*. If a colour is ever decorative,
 * it is a mistake.
 *
 * The rule that keeps it small: **no class is needed to render a page correctly.** `table`, `button`,
 * `input`, `h1`, `h2`, `.note` and `.warning` are styled by element or by names the product already
 * used. A class is added only when it names something that exists — `.card`, `.badge`, `.tile`.
 */
/**
 * The canvas colour, named once.
 *
 * The sheet paints it, and `page()` hands the same two values to `<meta name="theme-color">` — a phone's
 * browser chrome in a slightly different grey from the page beneath it is the first thing a person sees, and
 * exactly the kind of detail that makes an interface feel assembled rather than designed. One source, so the
 * bar and the page cannot drift apart.
 */
export const CANVAS = { light: '#f6f7f4', dark: '#0d1513' };

const TOKENS = `
  :root {
    color-scheme: light;

    /* Surfaces: canvas, card, and the recessed fill used for table headers and inputs. */
    --canvas: ${CANVAS.light};
    --surface: #ffffff;
    --sunken: #edf1ec;
    --line: #dfe6de;
    --line-2: #7b8f80;

    /* Ink, in four weights. Headings are a very dark navy rather than black: it reads as
       considered rather than default, and it is what makes a white page feel expensive. */
    --ink: #172d25;
    --ink-2: #30443b;
    --soft: #4e625a;
    /* The quietest ink, and the only one whose whole job is small type: table headers, eyebrows, the footer.
       It was #8b95a3, which measures 2.9:1 on the canvas — a label a person has to work to read is not a
       subtle label, it is a missing one. #656e7b measures 4.9:1 on the canvas, 5.2 on a card and 4.7 on
       the sunken fill, so the smallest type in the product clears AA on every surface it is actually used
       on. Measured with the same formula the checkers would use, not chosen by eye. */
    --faint: #58675f;

    --link: #155e48;
    --brand: #167052;
    --primary: #164e3c;
    --primary-ink: #ffffff;

    /* State. Five families, five meanings, no other colour anywhere. */
    --ok-bg: #ecfdf3;    --ok-ink: #05663e;    --ok-line: #b7ebc9;
    --info-bg: #eff5ff;  --info-ink: #1849b8;  --info-line: #c8dafd;
    --warn-bg: #fffaeb;  --warn-ink: #a35a06;  --warn-line: #f5e0ab;
    --bad-bg: #fef3f2;   --bad-ink: #a92319;   --bad-line: #fbcdc8;
    --off-bg: #f2f4f7;   --off-ink: #55606d;   --off-line: #e0e4ea;

    /* Elevation, tinted with the ink. A shadow coloured with black reads as a smudge; one tinted
       with the page's own navy reads as light. Every layer carries a 1px ring so a card has an
       edge even where the diffused shadow has faded to nothing. */
    --sh-1: 0 0 0 1px rgba(19, 28, 43, .05), 0 1px 2px rgba(19, 28, 43, .05);
    --sh-2: 0 0 0 1px rgba(19, 28, 43, .06), 0 2px 4px -2px rgba(19, 28, 43, .08), 0 10px 24px -12px rgba(19, 28, 43, .12);
    --sh-3: 0 0 0 1px rgba(19, 28, 43, .06), 0 18px 40px -16px rgba(19, 28, 43, .18);
    --focus: 0 0 0 3px color-mix(in srgb, var(--link) 22%, transparent);

    --r-xs: 5px; --r-sm: 7px; --r-md: 9px; --r-lg: 12px; --r-pill: 999px;
    --control: 44px; --control-sm: 36px;
    /* The sticky header's height: the shell uses it, and so does the offset an anchor needs. */
    --header: 4rem;
    /* The page's side margin, and the notch. A client opens their page on a phone, often in landscape, and
       the content must not run under the rounded corner of the screen. One gutter for the whole shell, so no
       page invents its own — and two derived tokens, because one max() per rule would be four copies of
       one fact. */
    --gutter: 1.5rem;
    --pad-l: max(var(--gutter), env(safe-area-inset-left));
    --pad-r: max(var(--gutter), env(safe-area-inset-right));

    --fs-xs: 12px; --fs-sm: 13px; --fs-md: 14px;
    --fs-base: 16px; --fs-lg: 18px; --fs-xl: 21px; --fs-2xl: 28px; --fs-3xl: 34px;

    --sans: Aptos, "Segoe UI", "Helvetica Neue", sans-serif;
    --display: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
    --sidebar: 14.5rem; --content: 76rem;
    --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem;
    --space-6: 1.5rem; --space-8: 2rem; --space-12: 3rem;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --canvas: ${CANVAS.dark};
      --surface: #14201c;
      --sunken: #101b17;
      --line: #283c32;
      --line-2: #668473;

      --ink: #e8f0eb;
      --ink-2: #d0ded5;
      --soft: #a0b3a8;
      /* The same rule as the light faint — 5.1:1 on the canvas, 4.8 on a card — so a table header is as
         readable in the dark as it is in the light. */
      --faint: #9caaa1;

      --link: #83d6b0;
      --brand: #83d6b0;
      --primary: #a5e6c7;
      --primary-ink: #10241b;

      --ok-bg: #06271b;    --ok-ink: #6ee7b7;    --ok-line: #12543a;
      --info-bg: #0c1a33;  --info-ink: #96b8ff;  --info-line: #1e3a6e;
      --warn-bg: #271a04;  --warn-ink: #f7c948;  --warn-line: #5a400d;
      --bad-bg: #280f0d;   --bad-ink: #f6a79e;   --bad-line: #5f221b;
      --off-bg: #161c26;   --off-ink: #9aa6b5;   --off-line: #2a3341;

      --sh-1: 0 0 0 1px rgba(255, 255, 255, .04), 0 1px 2px rgba(0, 0, 0, .5);
      --sh-2: 0 0 0 1px rgba(255, 255, 255, .05), 0 10px 24px -12px rgba(0, 0, 0, .7);
      --sh-3: 0 0 0 1px rgba(255, 255, 255, .06), 0 18px 40px -16px rgba(0, 0, 0, .8);
    }
  }
`;

const BASE = `
  *, *::before, *::after { box-sizing: border-box; }
  html {
    -webkit-text-size-adjust: 100%;
    /* A page that scrolls and a page that does not must not differ by a scrollbar's width, or every move
       to a longer list shifts the whole layout sideways. */
    scrollbar-gutter: stable;
  }
  body {
    margin: 0;
    font: var(--fs-base)/1.6 var(--sans);
    color: var(--ink-2);
    background: var(--canvas);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-rendering: optimizeLegibility;
  }
  ::selection { background: color-mix(in srgb, var(--brand) 26%, transparent); }
  /* Every control here has its own hover and pressed state, so the grey flash a phone paints on tap is a
     second, worse signal — and the double-tap delay it arrives with is a third. */
  a, button, .btn, label, summary, input, select, textarea { touch-action: manipulation; }
  a, button, .btn, label, summary { -webkit-tap-highlight-color: transparent; }
  @media (prefers-reduced-motion: reduce) {
    * { transition: none !important; animation: none !important; }
  }

  /* --- the page frame ---------------------------------------------------------------------- */
  .wrap {
    width: 100%; max-width: var(--content); margin: 0 auto;
    padding: 1.75rem var(--pad-r) 4.5rem var(--pad-l);
  }
  @media (max-width: 40rem) {
    /* The narrow-screen gutter is a token rather than a second padding, so the notch is inside it too. */
    :root { --gutter: 1rem; }
    .wrap { padding: 1.25rem var(--pad-r) 3rem var(--pad-l); }
  }

  /* --- the top of every page --------------------------------------------------------------- */
  .top {
    position: sticky; top: 0; z-index: 20;
    display: flex; align-items: center; gap: 1.25rem;
    padding: 0 var(--pad-r) 0 var(--pad-l); height: var(--header);
    background: color-mix(in srgb, var(--canvas) 82%, transparent);
    backdrop-filter: saturate(180%) blur(12px);
    border-bottom: 1px solid var(--line);
  }
  .top .brand {
    display: inline-flex; align-items: center; gap: .5rem; flex: none;
    font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.02em;
    color: var(--ink); text-decoration: none;
  }
  .top .brand .mark { display: block; flex: none; border-radius: 6px; box-shadow: var(--sh-1); }
  .top nav { margin-left: auto; display: flex; align-items: center; gap: .25rem; }
  .top nav a {
    padding: .3rem .6rem; border-radius: var(--r-sm);
    font-size: var(--fs-md); font-weight: 550; color: var(--soft); text-decoration: none;
    transition: background .14s ease, color .14s ease;
  }
  .top nav a:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .top nav a[aria-current=page] { color: var(--ink); background: var(--sunken); }
  .top .who {
    margin-left: .5rem; padding-left: .9rem;
    font-size: var(--fs-sm); color: var(--soft);
    border-left: 1px solid var(--line);
    max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    /* It is a link now — the way into your own account — so it has to read as one without shouting. */
    text-decoration: none;
  }
  .top .who:hover { color: var(--ink); }
  .top form { margin: 0; display: inline-flex; }
  @media (max-width: 44rem) {
    .top { height: auto; flex-wrap: wrap; gap: .5rem .9rem; padding: .6rem var(--pad-r) .6rem var(--pad-l); }
    .top nav { margin-left: 0; width: 100%; }
    .top .who { display: none; }
  }

  .foot {
    max-width: var(--content); margin: 0 auto; padding: 1.5rem var(--pad-r) 3rem var(--pad-l);
    border-top: 1px solid var(--line);
    font-size: var(--fs-sm); color: var(--faint); line-height: 1.65;
  }
  .foot strong { color: var(--soft); font-weight: 600; }

  /* The sticky header must not land on top of whatever a link just jumped to — an anchor, or the skip
     link's own target. One rule rather than an offset invented per page. */
  [id] { scroll-margin-top: calc(var(--header) + .9rem); }

  /* --- type -------------------------------------------------------------------------------- */
  h1, h2, h3 {
    color: var(--ink); font-weight: 600; letter-spacing: -.02em;
    margin: 0 0 .5rem; text-wrap: balance;
  }
  h1 { font-family: var(--display); font-size: 2rem; font-weight: 500; line-height: 1.2; }
  h2 { font-size: var(--fs-lg); line-height: 1.35; letter-spacing: -.015em; }
  h3 { font-size: var(--fs-base); line-height: 1.4; }
  p { margin: .55rem 0; }
  p:first-child { margin-top: 0; }
  p:last-child { margin-bottom: 0; }
  a { color: var(--link); text-decoration: none; text-underline-offset: 2px; }
  a:hover { text-decoration: underline; text-decoration-thickness: 1.5px; }
  strong, b { font-weight: 600; color: var(--ink); }
  small { font-size: var(--fs-sm); }
  hr { border: 0; border-top: 1px solid var(--line); margin: 1.75rem 0; }
  code {
    font-family: var(--mono); font-size: .87em;
    background: var(--sunken); color: var(--ink-2);
    padding: .1rem .35rem; border-radius: var(--r-xs);
    border: 1px solid var(--line);
  }
  pre { overflow-x: auto; }
  .num, td[align=right], th[align=right] { font-variant-numeric: tabular-nums; }
  .note { color: var(--soft); font-size: var(--fs-md); }
  .muted { color: var(--faint); }
  .lead { font-size: var(--fs-lg); line-height: 1.55; color: var(--soft); max-width: 46rem; }
  /* A sentence should break where it means to rather than where the column ends. Two extra lines per
     paragraph is what a widow costs; this is the cheapest way not to pay it, where the browser can. */
  .lead, .note, .empty .p, .page-head .sub, .foot { text-wrap: pretty; }
  .count { font-size: var(--fs-base); font-weight: 550; color: var(--ink); margin: .85rem 0 .35rem; }
  .eyebrow, .crumbs {
    font-size: var(--fs-xs); font-weight: 650; letter-spacing: .07em;
    text-transform: uppercase; color: var(--faint); margin: 0 0 .4rem;
  }
  .crumbs a { color: var(--faint); }
  .crumbs a:hover { color: var(--soft); }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
  }
  /* The first thing a keyboard meets, and nothing at all until it is used: eight navigation links stand
     between somebody pressing Tab and the page's own content, and a link that skips them is worth more
     than the eight it passes. It is revealed by focus rather than hidden from a screen reader. */
  .skip {
    position: absolute; left: .75rem; top: .6rem; z-index: 60;
    padding: .45rem .7rem; border-radius: var(--r-sm);
    background: var(--surface); border: 1px solid var(--line-2); box-shadow: var(--sh-2);
    color: var(--ink); font-size: var(--fs-md); font-weight: 550; text-decoration: none;
    transform: translateY(-250%);
    transition: transform .12s ease;
  }
  .skip:focus { transform: none; text-decoration: none; }
`;

const COMPONENTS = `
  /* --- a page's own header: what this is, and what you can do here -------------------------- */
  .page-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: 1rem 1.5rem; flex-wrap: wrap; margin: 0 0 1.25rem;
  }
  .page-head > .titles { min-width: 0; }
  .page-head h1 { margin: 0 0 .2rem; }
  .page-head .sub { color: var(--soft); font-size: var(--fs-md); margin: 0; }
  .page-head .do { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; flex: none; }
  @media (max-width: 34rem) { .page-head .do { width: 100%; } }

  /* --- a toolbar: filters on the left, actions on the right --------------------------------- */
  .bar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin: 0 0 1rem; }
  .bar .spacer { margin-left: auto; }
  /* A search box is a GET form, because a filter belongs in the address bar — a search you cannot
     send to a colleague or bookmark is a search that has to be redone. */
  .search { display: flex; align-items: center; gap: .4rem; margin: 0 0 0 auto; }
  .search input[type=search] { width: 13rem; height: var(--control-sm); font-size: var(--fs-md); }
  .search button { height: var(--control-sm); padding: 0 .6rem; font-size: var(--fs-sm); }
  .search .clear { font-size: var(--fs-sm); color: var(--soft); }
  .bar + .search, .search + .seg { margin-left: 0; }
  @media (max-width: 40rem) { .search { margin-left: 0; width: 100%; } .search input[type=search] { flex: 1; width: auto; } }

  /* A page whose whole purpose is searching, rather than a search box in a toolbar: one wide field, and the
     explanation of what it can and cannot look at underneath it rather than beside it. */
  .search-page { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
  .search-page input[type=search] { flex: 1 1 18rem; width: auto; }
  .search-page > p { flex: 1 0 100%; margin: .35rem 0 0; }

  /* --- a segmented switch, for two or three mutually exclusive views of one list ------------- */
  .seg {
    display: inline-flex; gap: 2px; padding: 2px;
    background: var(--sunken); border: 1px solid var(--line); border-radius: var(--r-md);
  }
  .seg a, .seg button {
    display: inline-flex; align-items: center; gap: .35rem;
    min-height: 36px; margin: 0; padding: 0 .6rem;
    font-size: var(--fs-md); font-weight: 550; color: var(--soft);
    background: none; border: 0; border-radius: var(--r-sm);
    box-shadow: none; text-decoration: none; cursor: pointer;
  }
  .seg a:hover, .seg button:hover { color: var(--ink); background: color-mix(in srgb, var(--ink) 5%, transparent); text-decoration: none; }
  .seg a[aria-current=page] { color: var(--ink); background: var(--surface); box-shadow: var(--sh-1); }

  /* --- buttons -----------------------------------------------------------------------------
     A bare button is already the secondary style, so a page needs no classes to be operable; the
     variants below exist for hierarchy. They are also classes, not only element styles, so that
     an anchor can wear them — a link styled as a button should not be a button inside a link. */
  button, .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
    height: var(--control); margin: 0; padding: 0 .75rem;
    font: inherit; font-size: var(--fs-md); font-weight: 550; line-height: 1;
    color: var(--ink-2); background: var(--surface);
    border: 1px solid var(--line-2); border-radius: var(--r-sm);
    box-shadow: 0 1px 1.5px rgba(19, 28, 43, .04);
    cursor: pointer; white-space: nowrap; text-decoration: none;
    transition: background .14s ease, border-color .14s ease, color .14s ease, box-shadow .14s ease, transform .06s ease;
  }
  button:hover:not(:disabled), .btn:hover { background: var(--sunken); text-decoration: none; }
  button:active:not(:disabled), .btn:active { transform: translateY(.5px); }
  button:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
  button:focus-visible, .btn:focus-visible, a:focus-visible,
  input:focus-visible, textarea:focus-visible, select:focus-visible {
    outline: 2px solid var(--link); outline-offset: 3px; box-shadow: var(--focus);
  }

  button.primary, .btn.primary {
    color: var(--primary-ink); background: var(--primary); border-color: var(--primary);
    box-shadow: var(--sh-1);
  }
  button.primary:hover:not(:disabled), .btn.primary:hover {
    background: color-mix(in srgb, var(--primary) 86%, var(--canvas)); border-color: transparent;
  }
  /* A form that is the page's one action gets the one primary button, without being told. */
  form.card > button[type=submit]:not(:disabled) {
    color: var(--primary-ink); background: var(--primary); border-color: var(--primary);
    box-shadow: var(--sh-1);
  }
  form.card > button[type=submit]:hover:not(:disabled) {
    background: color-mix(in srgb, var(--primary) 86%, var(--canvas)); border-color: transparent;
  }
  button.ghost, .btn.ghost { color: var(--soft); background: none; border-color: transparent; box-shadow: none; }
  button.ghost:hover:not(:disabled), .btn.ghost:hover {
    color: var(--ink); background: color-mix(in srgb, var(--ink) 6%, transparent);
  }
  button.danger, .btn.danger { color: var(--bad-ink); background: var(--bad-bg); border-color: var(--bad-line); }
  button.danger:hover:not(:disabled), .btn.danger:hover { background: color-mix(in srgb, var(--bad-ink) 8%, var(--bad-bg)); }
  .btn.sm, button.sm { height: var(--control-sm); padding: 0 .55rem; font-size: var(--fs-sm); border-radius: var(--r-xs); }
  .btn.lg, button.lg { height: 40px; padding: 0 1.1rem; font-size: var(--fs-base); }

  /* A row of actions, so buttons never float in prose. */
  .actions { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }
  .actions button, .actions .btn { margin: 0; }
  .actions.end { justify-content: flex-end; }
  .card > button[type=submit], .card > .btn { margin-top: 1rem; }
  form.inline button, form.inline .btn { margin: 0; }
`;

const FORMS = `
  /* --- form fields -------------------------------------------------------------------------
     One control height, one radius, one focus ring, and a column of fields so the rhythm is the
     same on every page. The hint sits under its control rather than beside the label, because a
     sentence squeezed next to a label is a sentence nobody reads. */
  label { display: block; margin: 0 0 .35rem; font-size: var(--fs-md); font-weight: 550; color: var(--ink-2); }
  label .note, label .muted { font-weight: 400; font-size: var(--fs-sm); }
  .field { margin: 0 0 1rem; }
  .form-hint, .hint { font-size: var(--fs-sm); color: var(--soft); margin: .3rem 0 0; }
  input, textarea, select {
    width: 100%; margin: 0; padding: 0 .6rem;
    font: inherit; font-size: var(--fs-md); color: var(--ink);
    background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--r-sm);
    height: var(--control);
    transition: border-color .14s ease, box-shadow .14s ease, background .14s ease;
  }
  textarea { height: auto; padding: .5rem .6rem; line-height: 1.6; resize: vertical; }
  input::placeholder, textarea::placeholder { color: var(--faint); }
  input:hover:not(:focus), textarea:hover:not(:focus), select:hover:not(:focus) { border-color: var(--faint); }
  input:focus, textarea:focus, select:focus { border-color: var(--link); box-shadow: var(--focus); outline: none; }
  input:disabled, textarea:disabled, select:disabled { background: var(--sunken); color: var(--soft); cursor: not-allowed; }
  select {
    appearance: none; padding-right: 1.9rem; cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%238b95a3' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat; background-position: right .55rem center; background-size: .75rem;
  }
  select option { color: var(--ink); background: var(--surface); }
  input[type=checkbox], input[type=radio] { width: auto; height: auto; accent-color: var(--brand); }
  input[type=file] { height: auto; padding: .35rem; background: var(--sunken); border-style: dashed; color: var(--soft); cursor: pointer; }
  input[type=file]:hover { border-color: var(--faint); }
  input[type=file]::file-selector-button {
    height: var(--control-sm); margin: 0 .6rem 0 0; padding: 0 .6rem;
    font: inherit; font-size: var(--fs-sm); font-weight: 550;
    color: var(--ink-2); background: var(--surface);
    border: 1px solid var(--line-2); border-radius: var(--r-xs); cursor: pointer;
  }
  input[type=file]::file-selector-button:hover { background: var(--sunken); }
  progress { width: 100%; height: 6px; accent-color: var(--brand); }

  form.inline { display: inline-flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin: 0; vertical-align: middle; }
  form.inline label { display: inline-flex; align-items: center; gap: .4rem; margin: 0; font-weight: 500; font-size: var(--fs-md); color: var(--soft); }
  form.inline input, form.inline select { width: auto; min-width: 9rem; height: var(--control-sm); font-size: var(--fs-md); }
  form.inline input[type=number] { min-width: 4.5rem; }
  form.passphrase, form.reencrypt { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; margin: 0 0 .5rem; }
  form.passphrase input, form.reencrypt input { flex: 1 1 9rem; width: auto; min-width: 8rem; height: var(--control-sm); font-size: var(--fs-sm); }
  form.passphrase button, form.reencrypt button { height: var(--control-sm); padding: 0 .55rem; font-size: var(--fs-sm); }
  form.passphrase .status, form.reencrypt .status { flex-basis: 100%; }
  .check {
    display: flex; align-items: flex-start; gap: .5rem; margin: 1.1rem 0 0;
    font-weight: 400; font-size: var(--fs-base); color: var(--ink-2);
  }
  .check input { flex: none; margin-top: .25rem; }
`;

const TABLES = `
  /* --- tables ------------------------------------------------------------------------------
     A table is a card with a hairline grid: it scrolls rather than squashing, its header sticks to
     the top of that scroll, and its numeric columns are tabular so digits line up down the page.
     A colgroup in the markup fixes the column widths where a table has a shape worth fixing — a
     table whose columns move depending on the length of a client's name is a table you have to
     re-read every time. */
  .scroll {
    overflow-x: auto; overscroll-behavior-x: contain;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--r-lg); box-shadow: var(--sh-1); margin: 0 0 1rem;
  }
  .scroll > table { margin: 0; }
  table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-md); }
  thead th {
    position: sticky; top: 0; z-index: 2;
    background: var(--sunken);
    padding: .5rem .75rem; text-align: left; vertical-align: bottom;
    font-size: var(--fs-xs); font-weight: 650; letter-spacing: .06em;
    text-transform: uppercase; color: var(--faint);
    border-bottom: 1px solid var(--line); white-space: nowrap;
  }
  td {
    padding: .6rem .75rem; vertical-align: middle;
    border-bottom: 1px solid var(--line);
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: color-mix(in srgb, var(--ink) 2.2%, transparent); }
  th:first-child, td:first-child { padding-left: 1rem; }
  th:last-child, td:last-child { padding-right: 1rem; }
  th[align=right], td[align=right] { text-align: right; }
  table .cell { display: block; }
  table .cell-t { display: block; font-weight: 550; color: var(--ink); }
  table .cell-s { display: block; font-size: var(--fs-sm); color: var(--soft); }
  table .cell-s + .cell-s, table .cell-t + .cell-s { margin-top: .15rem; }
  a.cell-t { text-decoration: none; }
  a.cell-t:hover { text-decoration: underline; }
  a.cell-s:hover { color: var(--link); text-decoration: none; }
  td .row { margin-top: .3rem; }
  td form.upload { margin: 0; }
  /* A file being dragged over a send form. A dashed ring is the only feedback a drop target needs. */
  form.upload.dropping { outline: 2px dashed var(--ink); outline-offset: 3px; border-radius: var(--r-sm); }
  td > form:last-child { margin-bottom: 0; }
  table.compact td { padding: .5rem .75rem; }

  /* The board: fixed columns, because its shape is the same every time. */
  table.board { table-layout: fixed; min-width: 46rem; }
  table.board col.c-client { width: 19%; }
  table.board col.c-request { width: 23%; }
  table.board col.c-state { width: 20%; }
  table.board col.c-due { width: 13%; }
  table.board col.c-out { width: 12.5%; }
  table.board col.c-check { width: 12.5%; }

  table.items { min-width: 44rem; }
  table.items col.c-doc { width: 24%; }
  table.items col.c-state { width: 20%; }
  table.items col.c-files { width: 26%; }
  table.items col.c-say { width: 30%; }
  /* The same table class, a different shape: a client's own history is short and read top-down. */
  table.items col.c-title { width: 34%; }
  table.items col.c-received { width: 14%; }
  table.items col.c-due { width: 16%; }
  table.items col.c-asked { width: 16%; }
  table.clients { min-width: 48rem; }
  table.clients col.c-name { width: 22%; }
  table.clients col.c-mail { width: 24%; }
  table.clients col.c-open { width: 8%; }
  table.clients col.c-out { width: 11%; }
  table.clients col.c-reminded { width: 14%; }
  table.clients col.c-do { width: 21%; }
  table.chase { min-width: 46rem; }
  table.keys, table.members { min-width: 42rem; }

  /* State, as a word you can scan down a column. */
  .badge {
    display: inline-flex; align-items: center; gap: .35rem;
    height: 20px; padding: 0 .5rem; border-radius: var(--r-pill);
    font-size: var(--fs-xs); font-weight: 600; letter-spacing: .01em;
    border: 1px solid; white-space: nowrap; vertical-align: middle;
    /* Most badges carry a count — documents, codes, people — and a count that shifts the pill's width as
       it grows is a list that twitches as it loads. */
    font-variant-numeric: tabular-nums;
  }
  .badge::before {
    content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%;
    background: currentColor; opacity: .8;
  }
  .badge.ok    { background: var(--ok-bg);   color: var(--ok-ink);   border-color: var(--ok-line); }
  /* What a client has told the practice in their own words, on their own page. */
  .said { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .said h3 { margin-top: 0; }
  .said p { margin: .35rem 0; }
  .said .when { color: var(--faint); font-size: var(--fs-sm); margin-right: .4rem; }
  .badge.wait  { background: var(--warn-bg); color: var(--warn-ink); border-color: var(--warn-line); }
  .badge.bad   { background: var(--bad-bg);  color: var(--bad-ink);  border-color: var(--bad-line); }
  .badge.off   { background: var(--off-bg);  color: var(--off-ink);  border-color: var(--off-line); }
  .badge.off::before { display: none; }
  .badge a { color: inherit; text-decoration: none; }

  /* Files inside a cell: a name, when it arrived, and one button — on their own lines. */
  .file { display: flex; align-items: center; gap: .4rem; flex-wrap: wrap; }
  .file + .file { margin-top: .4rem; padding-top: .4rem; border-top: 1px dashed var(--line); }
  .file .name { font-weight: 550; color: var(--ink); }
  .file .note { font-size: var(--fs-sm); }
  .file .save { height: var(--control-sm); padding: 0 .55rem; font-size: var(--fs-sm); }

  /* --- tiles: one number, and the words that name it ---------------------------------------- */
  .tiles {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr));
    gap: .75rem; margin: 0 0 1.5rem;
  }
  .tile {
    display: block; padding: 1.1rem 1.2rem; text-decoration: none;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md);
    box-shadow: var(--sh-1); transition: box-shadow .15s ease, border-color .15s ease, transform .1s ease;
  }
  .tiles a.tile:hover { box-shadow: var(--sh-2); text-decoration: none; transform: translateY(-1px); }
  .tile .n {
    font-size: var(--fs-2xl); font-weight: 600; line-height: 1.15; letter-spacing: -.03em;
    color: var(--ink); font-variant-numeric: tabular-nums;
  }
  .tile .k { font-size: var(--fs-sm); color: var(--soft); margin-top: .1rem; }
  .tile.attn .n { color: var(--info-ink); }
  .tile.warn .n { color: var(--warn-ink); }
  .tile[aria-current=page] { border-color: var(--ink); box-shadow: var(--sh-2); }
`;

const SURFACES = `
  /* --- cards --------------------------------------------------------------------------------
     A card is a section with an edge. When a heading is its first child the heading becomes the
     card's own header band, so a long page reads as labelled blocks rather than as a column. */
  .card {
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--r-lg); box-shadow: var(--sh-1);
    padding: 1.25rem; margin: 0 0 1rem;
  }
  .card > h2:first-child, .card > h3:first-child {
    margin: -1.25rem -1.25rem 1rem; padding: .8rem 1.25rem;
    border-bottom: 1px solid var(--line); border-radius: var(--r-lg) var(--r-lg) 0 0;
    font-size: var(--fs-base); letter-spacing: -.01em;
  }
  .card > :last-child { margin-bottom: 0; }
  .card.tight { padding: 1rem; }
  .card.tight > h2:first-child { margin: -1rem -1rem .85rem; padding: .65rem 1rem; }
  .grid-2 { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }

  /* --- notices ------------------------------------------------------------------------------ */
  .error, .warning, .success, .info {
    padding: .7rem .9rem; border-radius: var(--r-md); margin: 0 0 1rem;
    border: 1px solid; border-left-width: 3px;
    font-size: var(--fs-md); line-height: 1.55;
  }
  .error   { background: var(--bad-bg);  color: var(--bad-ink);  border-color: var(--bad-line); }
  .warning { background: var(--warn-bg); color: var(--warn-ink); border-color: var(--warn-line); }
  .success { background: var(--ok-bg);   color: var(--ok-ink);   border-color: var(--ok-line); }
  .info    { background: var(--info-bg); color: var(--info-ink); border-color: var(--info-line); }
  .error strong, .warning strong, .success strong, .info strong { color: inherit; }
  .error a, .warning a, .success a, .info a { color: inherit; }
  .error > :first-child, .warning > :first-child, .success > :first-child, .info > :first-child { margin-top: 0; }
  .error > :last-child, .warning > :last-child, .success > :last-child, .info > :last-child { margin-bottom: 0; }
  /* For a warning that must be read before anything else on the page happens. */
  .danger {
    background: var(--bad-bg); color: var(--bad-ink);
    border: 1.5px solid var(--bad-line); border-left-width: 5px;
    border-radius: var(--r-lg); padding: 1rem 1.15rem; margin: 1.25rem 0;
  }
  .danger p { margin: .4rem 0; }
  .danger strong { color: inherit; }

  /* --- an empty list, said properly: what is missing, and what to do about it ---------------- */
  .empty {
    text-align: center; padding: 2.5rem 1.5rem;
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--r-lg); box-shadow: var(--sh-1); margin: 0 0 1rem;
  }
  .empty .h { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -.015em; color: var(--ink); }
  .empty .p { font-size: var(--fs-md); color: var(--soft); max-width: 34rem; margin: .35rem auto 0; }
  .empty .actions { justify-content: center; }

  /* --- the practice's own words to a client ------------------------------------------------- */
  .greeting {
    position: relative; padding: .9rem 1.1rem .9rem 1.25rem; margin: 0 0 1.25rem;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg);
    box-shadow: var(--sh-1); white-space: pre-wrap;
    font-size: var(--fs-base); color: var(--ink-2); line-height: 1.6;
  }
  .greeting::before {
    content: ''; position: absolute; inset: 0 auto 0 0; width: 3px;
    background: var(--brand); border-radius: var(--r-lg) 0 0 var(--r-lg);
  }

  /* --- a key/value list, for facts about one thing ------------------------------------------- */
  .facts { display: grid; grid-template-columns: auto 1fr; gap: .4rem 1.25rem; margin: 0; }
  .facts dt {
    font-size: var(--fs-xs); font-weight: 650; letter-spacing: .06em; text-transform: uppercase;
    color: var(--faint); padding-top: .14rem;
  }
  .facts dd { margin: 0; font-size: var(--fs-md); color: var(--ink-2); }
`;

const CLIENT_AND_MISC = `
  /* --- the client's own page: the one a stranger sees, so it is the friendliest -------------- */
  .client .who { font-size: var(--fs-lg); color: var(--soft); margin: 0 0 1.25rem; }
  .client .badge { height: 22px; font-size: var(--fs-sm); }
  .client .upload .status { font-size: var(--fs-sm); }
  /* A check the browser made and the client can act on: not a refusal, so not the error colour either. */
  .client .upload .status.warn { color: var(--warn-ink); }

  /* --- misc --------------------------------------------------------------------------------- */
  .stack { display: grid; gap: .5rem; }
  .row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
  .row.between { justify-content: space-between; }
  .row.tight { gap: .35rem; }
  .center { max-width: 26rem; margin: 3.5rem auto; }
  .center .card { padding: 1.75rem; box-shadow: var(--sh-3); }
  .center h1 { margin-bottom: 1.25rem; text-align: center; font-size: var(--fs-xl); }
  .center form button { width: 100%; margin-top: 1.5rem; }
  .center .note { text-align: center; }
  .hero { max-width: 40rem; }
  .hero h1 { font-size: var(--fs-3xl); letter-spacing: -.03em; margin: .35rem 0 .75rem; }
  .hero .lead { font-size: var(--fs-xl); line-height: 1.5; }
  .hero .tiles { margin-top: 2rem; }
  .hero .actions { margin-top: 1.5rem; }
  .narrow { max-width: 32rem; }
  .unlock {
    display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
    padding: .85rem 1rem; margin: 0 0 1rem;
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md);
    box-shadow: var(--sh-1);
  }
  .unlock label { margin: 0; }
  .unlock input { width: auto; min-width: 15rem; }
  .unlock .note { flex-basis: 100%; margin: 0; }
  /* A secret somebody is going to type, and the codes they have to write down. */
  .secret {
    font-family: var(--mono); font-size: var(--fs-md); letter-spacing: .08em;
    background: var(--sunken); border: 1px solid var(--line); border-radius: var(--r-sm);
    padding: .7rem .9rem; word-break: break-all; max-width: 30rem;
  }
  code.wrap { word-break: break-all; display: inline-block; max-width: 100%; }
  input.code-input {
    font-family: var(--mono); font-size: 1.25rem; letter-spacing: .22em; text-align: center;
    max-width: 12rem; height: var(--control);
  }
  ul.codes {
    list-style: none; padding: 0; margin: 1rem 0;
    display: grid; gap: .5rem; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    max-width: 32rem;
  }
  ul.codes li code {
    display: block; text-align: center; font-size: var(--fs-md); letter-spacing: .1em;
    padding: .5rem .6rem; background: var(--surface); border: 1px solid var(--line-2);
  }

  /* The list of things to do before the product makes sense, each with a tick or a way to do it. */
  .steps-list { list-style: none; padding: 0; margin: .5rem 0 0; display: grid; gap: .9rem; }
  .steps-list > li { display: flex; gap: .75rem; align-items: flex-start; }
  .steps-list .tick {
    flex: none; width: 1.35rem; height: 1.35rem; margin-top: .1rem;
    display: grid; place-items: center; border-radius: 50%;
    font-size: var(--fs-sm); font-weight: 700;
    background: var(--sunken); border: 1px solid var(--line-2); color: var(--soft);
  }
  .steps-list li.done .tick { background: var(--ok-bg); border-color: var(--ok-line); color: var(--ok-ink); }
  .steps-list li.done strong { color: var(--soft); text-decoration: line-through; }
  .steps-list strong { display: block; }
  .steps-list .cell-s { display: block; margin: .15rem 0 .5rem; max-width: 44rem; }
  .steps-list .row.tight { margin: 0; }

  /* A correction hiding behind a word, rather than three inputs in every row. */
  details.rename { margin-top: .35rem; }
  details.rename > summary {
    cursor: pointer; list-style: none; position: relative;
    font-size: var(--fs-sm); color: var(--faint); width: fit-content;
    padding: .1rem .95rem .1rem .3rem; border-radius: var(--r-xs);
  }
  /* It had no mark of its own, so the only way to know it opened was to click it. A small chevron in the
     current ink turns "there is something behind this word" into something a person can see. */
  details.rename > summary::after {
    content: ''; position: absolute; right: .42rem; top: .42rem;
    width: .3rem; height: .3rem;
    border-right: 1.6px solid currentColor; border-bottom: 1.6px solid currentColor;
    transform: rotate(45deg); transition: transform .14s ease;
  }
  details.rename[open] > summary::after { transform: rotate(-135deg); top: .58rem; }
  details.rename > summary::-webkit-details-marker { display: none; }
  details.rename > summary:hover { color: var(--soft); background: color-mix(in srgb, var(--ink) 5%, transparent); }
  details.rename[open] > summary { color: var(--soft); }
  details.rename .stack { margin-top: .5rem; max-width: 26rem; }
  details.rename input { height: var(--control-sm); font-size: var(--fs-sm); }
  details.rename button { height: var(--control-sm); padding: 0 .55rem; font-size: var(--fs-sm); }
  /* The list of things to tick: one per line, the whole line a target. */
  .pick { display: grid; gap: .1rem; }
  .pick label {
    display: flex; align-items: flex-start; gap: .6rem; margin: 0;
    padding: .5rem .6rem; border-radius: var(--r-sm); font-weight: 400; cursor: pointer;
  }
  .pick label:hover { background: color-mix(in srgb, var(--ink) 3%, transparent); }
  .pick input { flex: none; margin-top: .2rem; }
  .pick .what { display: block; font-weight: 550; color: var(--ink); }
  .pick .who { display: block; font-size: var(--fs-sm); color: var(--soft); }
  /* A row that cannot be chosen, for a reason the row itself explains. Nothing is hidden: a client nobody can
     write to is a fact the practice has to be able to see, and a checkbox that silently does not exist reads as
     a client who does not exist either. */
  .pick label.off { cursor: default; opacity: .62; }
  .pick label.off:hover { background: none; }
  .pick label.off .what { color: var(--soft); }
  ul.plain { list-style: none; padding: 0; margin: .5rem 0; }
  ul.plain li { padding: .45rem 0; border-bottom: 1px solid var(--line); }
  ul.plain li:last-child { border-bottom: 0; }

  /* --- icons, and the things they lead ------------------------------------------------------------ */
  /* An icon is the colour of the text it sits in, and sits on the text's baseline rather than beside its bottom.
     Without the vertical nudge the glyph reads as dropping off the end of the line, which is the difference between
     an icon that belongs to a sentence and one pasted next to it. */
  .icon { flex: none; vertical-align: -.18em; }
  .icon.lead { width: 1.05rem; height: 1.05rem; vertical-align: -.22em; }

  /* A claim, made once, with the mark that means it. Used on the public pages where a stranger has to decide
     whether to trust the thing in front of them — so it is a sentence rather than a bullet, and it is the only
     icon-led block on the page. */
  .promise {
    display: flex; gap: .7rem; align-items: flex-start;
    max-width: 34rem; margin: 1.25rem 0 0;
    padding: .85rem 1rem; border-radius: var(--r-lg);
    background: var(--ok-bg); color: var(--ok-ink); border: 1px solid var(--ok-line);
  }
  .promise .icon { width: 1.15rem; height: 1.15rem; margin-top: .1rem; }
  .promise strong { display: block; font-weight: 620; }
  .promise p { margin: .15rem 0 0; }
  .promise.quiet { background: var(--canvas); color: var(--soft); border-color: var(--line); }
  .promise.quiet strong { color: var(--ink); }

  /* Three or four things that are true, ticked. Shorter than prose and faster to read than bullets, which is the
     whole reason it exists — a page asking somebody to hand over a practice's name and an email has one chance to
     answer "what is this" before they close the tab. */
  ul.ticks { list-style: none; padding: 0; margin: 1.15rem 0 0; display: grid; gap: .5rem; max-width: 34rem; }
  ul.ticks li { display: flex; gap: .6rem; align-items: flex-start; font-size: .9375rem; }
  ul.ticks .icon { width: 1rem; height: 1rem; margin-top: .22rem; color: var(--brand); }
  ul.ticks span { min-width: 0; }
  ul.ticks .note { display: block; }

  /* A heading with a mark beside it, for the state of something — a subscription, a key, a lock. The mark carries
     the tone, so the words do not have to. */
  .state { display: flex; gap: .75rem; align-items: flex-start; }
  .state > div { min-width: 0; }
  .state .icon { width: 1.35rem; height: 1.35rem; margin-top: .1rem; }
  .state h1, .state h2 { margin: 0 0 .15rem; }
  .state .sub { color: var(--soft); font-size: var(--fs-md); margin: .15rem 0 0; }
  /* The badge sits at the far end of the row. The .do rule is styled under .page-head and nowhere else, so a .do
     in a state block silently got nothing — which is what happened the first time, and it looks like a badge that
     forgot where it was. (Also: never write a backtick in this file. The sheet is a template literal, and one
     backtick in a comment ends the string and breaks the module — a mistake made three times in this project.) */
  .state .do { margin-left: auto; display: flex; align-items: center; gap: .5rem; flex: none; }
  .state .icon.ok { color: var(--ok-ink); }
  .state .icon.wait { color: var(--warn-ink); }
  .state .icon.bad { color: var(--bad-ink); }
  .state .icon.off { color: var(--faint); }

  /* What a page is for, when there is one obvious next thing. */
  .onward { display: flex; align-items: center; gap: .5rem; margin: 1.5rem 0 0; }
  .onward .icon { color: var(--faint); }
  .onward a { font-weight: 550; }

  /* The public pages centre their content and give it room, because the person reading them has not decided to
     trust anything yet. */
  .gateway .card { margin-top: 1.5rem; }
  .gateway .aside { margin-top: 1.25rem; font-size: .9375rem; color: var(--soft); }
  .gateway .aside a { font-weight: 550; }

  /* --- on paper ----------------------------------------------------------------------------------
     A practice prints things: a checklist for a meeting, a request page to write on. On paper the header,
     the nav, the footer and every button are furniture — and a shadow is a grey smudge. What is left is
     what the page says. Nothing here changes a screen; it is the same document with the chrome taken off. */
  @media print {
    @page { margin: 1.4cm; }
    .top, .foot, .skip, .actions, .search, .bar, .onward, .pick, form button, .tile[href] { display: none; }
    body { background: #fff; }
    .wrap { max-width: none; padding: 0; }
    .card, .scroll, .empty, .greeting { box-shadow: none; }
    /* A row or a card split across two sheets is a list nobody can read; let the printer move it whole. */
    .card, .scroll, .empty, .greeting, tr, .tile { break-inside: avoid; }
    .card > h2:first-child { border-radius: 0; }
    /* With the shadow gone a border is the only structure left, so it has to survive the toner. */
    .card, .scroll, .empty, .greeting { border-color: #c9ccd2; }
    thead th { background: none; color: var(--ink); }
    a { color: inherit; text-decoration: none; }
    /* The one block a reader must not miss keeps its tint, which needs saying out loud to a printer. */
    .danger { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
    table { font-size: 11.5px; }
  }
`;

/**
 * Column widths, as classes.
 *
 * They were inline `style="width: …"` attributes on colgroup columns and header cells — and a strict
 * Content-Security-Policy refuses style *attributes*: a nonce can bless a `<style>` block, never an
 * attribute. So the widths live here, where styling lives, and the markup says `class="w34"` instead
 * of inventing a number per table. (`tools/check-pages.mjs` fails a page that brings one back.)
 */
const SHELL = `
  .app-layout.public-layout { display: block; }
  .public-site { padding: .6rem; }
  .workspace .top { background: var(--surface); backdrop-filter: none; }
  .workspace-label { color: var(--soft); font-size: var(--fs-sm); border-left: 1px solid var(--line); padding-left: 1rem; }
  .app-layout { display: grid; grid-template-columns: var(--sidebar) minmax(0, 1fr); min-height: calc(100vh - var(--header)); }
  .sidebar { position: sticky; top: var(--header); height: calc(100vh - var(--header)); overflow-y: auto; padding: 1.6rem 1rem; border-right: 1px solid var(--line); background: var(--surface); }
  .nav-group + .nav-group { margin-top: 1.75rem; }
  .nav-label { font-size: var(--fs-xs); font-weight: 650; color: var(--soft); letter-spacing: .08em; text-transform: uppercase; padding: 0 .75rem; margin-bottom: .5rem; }
  .sidebar nav a, .mobile-nav nav a { display: flex; align-items: center; gap: .75rem; min-height: 44px; padding: .65rem .75rem; border-radius: var(--r-sm); color: var(--soft); font-size: var(--fs-md); font-weight: 550; text-decoration: none; }
  .sidebar nav a:hover, .mobile-nav nav a:hover { background: var(--sunken); color: var(--ink); }
  .sidebar nav a[aria-current=page], .mobile-nav nav a[aria-current=page] { background: var(--ok-bg); color: var(--ok-ink); box-shadow: inset 3px 0 var(--brand); }
  .sidebar-note { margin: 2rem .75rem 0; padding-top: 1rem; border-top: 1px solid var(--line); font-size: var(--fs-xs); color: var(--soft); }
  .workspace .wrap { min-width: 0; padding-top: 2rem; }
  .workspace .foot { margin-left: var(--sidebar); }
  .mobile-nav { display: none; }
  .account-actions { margin-left: auto; display: flex; align-items: center; gap: .5rem; }
  .account-actions form { margin: 0; }
  .request-summary { display: flex; align-items: center; gap: 1.5rem; justify-content: space-between; flex-wrap: wrap; margin: 1rem 0; }
  .request-summary progress { width: 15rem; height: .6rem; }
  .timeline { list-style: none; padding: 0 0 0 1.4rem; margin: 1rem 0; border-left: 1px solid var(--line-2); }
  .timeline li { position: relative; padding: .65rem 0 1rem; overflow-wrap: anywhere; }
  .timeline li::before { content: ""; position: absolute; left: -1.7rem; top: 1rem; width: .5rem; height: .5rem; border-radius: 50%; background: var(--brand); outline: 4px solid var(--canvas); }
  .page-head { padding-bottom: 1.25rem; border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; }
  .page-head .sub { max-width: 48rem; margin-top: .5rem; line-height: 1.6; }
  .scroll { scrollbar-color: var(--line-2) var(--surface); }
  :focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
  input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
  .scroll:focus-visible { outline: 2px solid var(--link); outline-offset: 3px; }
  .gateway { max-width: 64rem; margin: 0 auto; padding: 2rem 0; }
  .gateway.auth-layout { display: grid; grid-template-columns: 1.1fr 1fr; gap: 4rem; align-items: start; }
  .gateway .hero h1 { font-family: var(--display); font-size: clamp(2.3rem, 4vw, 3.25rem); font-weight: 500; line-height: 1.12; }
  .gateway .hero .lead { font-size: var(--fs-lg); }
  .auth-panel { padding: 1.5rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--sh-2); }
  .auth-panel form.card { padding: 0; margin: 1.25rem 0 0; border: 0; box-shadow: none; }
  .auth-panel form button { width: 100%; margin-top: 1.25rem; }
  .auth-panel .aside { font-size: var(--fs-md); }
  .auth-intro .promise, .auth-intro .ticks { max-width: none; }
  .center { max-width: 30rem; }
  .center h1 { font-family: var(--display); font-size: 2rem; font-weight: 500; text-align: left; }
  .center .note { text-align: left; }
  .client { max-width: 48rem; margin: 0 auto; }
  .public-layout main > h1 { font-family: var(--display); font-size: 2.5rem; font-weight: 500; margin-top: 2rem; max-width: 44rem; }
  .public-layout main > p { max-width: 44rem; }
  .client-privacy { margin: 1rem 0; padding: .8rem 1rem; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); }
  .client-privacy summary { padding: .5rem 0; cursor: pointer; color: var(--ink); font-size: var(--fs-md); font-weight: 600; min-height: 44px; }
  .client-privacy[open] summary { margin-bottom: .75rem; }
  .client-identity { padding-bottom: 1.5rem; border-bottom: 1px solid var(--line); margin-bottom: 1.5rem; }
  .client h1 { font-family: var(--display); font-size: clamp(2rem, 5vw, 2.8rem); font-weight: 500; line-height: 1.16; }
  .client-summary { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin: 1.5rem 0; }
  .client-summary progress { width: 14rem; height: .65rem; accent-color: var(--brand); }
  .client-checklist { list-style: none; padding: 0; display: grid; gap: 1rem; counter-reset: checklist; }
  .client-item { padding: 1.5rem; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); box-shadow: var(--sh-1); }
  .client-item-head { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: .75rem; margin-bottom: 1.25rem; }
  .client-item h2 { font-size: var(--fs-lg); margin: 0; }
  .client .cell-s { display: block; font-size: var(--fs-sm); color: var(--soft); margin-top: .35rem; overflow-wrap: anywhere; }
  .client .upload { display: flex; flex-direction: column; margin: 0; padding: 1rem; background: var(--sunken); border: 1px dashed var(--line-2); border-radius: var(--r-md); gap: .75rem; }
  .client .upload input { max-width: 100%; }
  .client .upload input[type=file] { padding: .5rem; background: var(--surface); }
  .client .upload button[type=submit] { color: var(--primary-ink); background: var(--primary); border-color: var(--primary); }
  .client .says { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .75rem; }
  .client .says button { min-height: 44px; white-space: normal; text-align: left; }
  .client .status { overflow-wrap: anywhere; }
  .client-support { margin-top: 2rem; padding-top: 1.5rem; border-top: 1px solid var(--line); }
  @media (max-width: 64rem) {
    .app-layout { display: block; }
    .sidebar { display: none; }
    .workspace .foot { margin-left: auto; }
    .workspace .top { height: auto; min-height: var(--header); flex-wrap: wrap; padding-top: .65rem; padding-bottom: .65rem; gap: .65rem; }
    .workspace-label { display: none; }
    .mobile-nav { display: block; margin-left: auto; }
    .mobile-nav summary { min-height: 44px; padding: .6rem .8rem; border: 1px solid var(--line-2); border-radius: var(--r-sm); cursor: pointer; font-size: var(--fs-md); }
    .mobile-nav nav { position: absolute; left: var(--pad-l); right: var(--pad-r); top: 100%; display: block; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--sh-3); border-radius: var(--r-lg); max-height: 70vh; overflow-y: auto; padding: 1rem; }
    .mobile-nav:not([open]) nav { display: none; }
    .account-actions .who { display: none; }
    .top .account-actions { width: auto; margin-left: 0; }
  }
  @media (max-width: 48rem) {
    .gateway.auth-layout { grid-template-columns: 1fr; gap: 2rem; }
    .gateway { padding: .5rem 0; }
    .auth-intro .ticks { display: none; }
    .client-item { padding: 1rem; }
    .client .upload { padding: .75rem; }
    .client-summary progress { width: 100%; }
    button.sm, .btn.sm, .seg a, .seg button { min-height: 44px; height: auto; }
    input, select, textarea { font-size: 16px; }
    .facts { grid-template-columns: 1fr; gap: .2rem; }
    .facts dd { margin-bottom: .8rem; overflow-wrap: anywhere; }
  }
  @media (forced-colors: active) {
    button, .btn, input, select, textarea, .card, .client-item { border: 1px solid CanvasText; }
    :focus-visible { outline: 3px solid Highlight; box-shadow: none; }
    .badge { border: 1px solid CanvasText; }
  }
  @media print { .sidebar, .mobile-nav, .account-actions { display: none; } .app-layout { display: block; } .workspace .foot { margin-left: 0; } }
`;

const WIDTHS = `
.w8  { width: 8%; }  .w9  { width: 9%; }  .w10 { width: 10%; } .w12 { width: 12%; }
.w14 { width: 14%; } .w15 { width: 15%; } .w17 { width: 17%; } .w18 { width: 18%; }
.w21 { width: 21%; } .w22 { width: 22%; } .w23 { width: 23%; } .w24 { width: 24%; }
.w26 { width: 26%; } .w29 { width: 29%; } .w30 { width: 30%; } .w32 { width: 32%; }
.w34 { width: 34%; } .w42 { width: 42%; } .w44 { width: 44%; } .w55 { width: 55%; }
.w78 { width: 78%; }`;

/**
 * The sheet, assembled. Order matters only in that later sections may refine earlier ones; nothing
 * here needs to win an argument with a `!important`.
 */
export const STYLE = `${TOKENS}\n${BASE}\n${COMPONENTS}\n${FORMS}\n${TABLES}\n${SURFACES}\n${CLIENT_AND_MISC}\n${SHELL}\n${WIDTHS}`;

// Canonical token block used by the standalone marketing output.
export const DESIGN_TOKENS = TOKENS;
