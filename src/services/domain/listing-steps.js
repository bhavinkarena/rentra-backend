/**
 * The listing walkthrough — one source of truth for BOTH chromes.
 *
 * The builder renders the same nine sections two ways:
 *   · /partner/listings/[id]/setup/[step]  full-screen walkthrough, one step
 *     at a time. For a DRAFT, where the job is "get to the end".
 *   · /partner/listings/[id]              every section on one page, random
 *     access. For a LIVE listing, where the job is "change one thing".
 *
 * That is what Airbnb does too, and it is why the sections live in their own
 * module: the walkthrough is a different chrome around identical forms, not a
 * second implementation.
 *
 * WHY CHAPTERS: nine steps is past the point where multi-step forms start
 * shedding people — the research consensus is that abandonment climbs beyond
 * about six. Grouping the nine into five named chapters means the bar reads
 * "2 of 5 · The space" instead of "4 of 9", which is the number that decides
 * whether someone keeps going. Labelled steps beat bare percentages for any
 * flow with five or more.
 */

/**
 * `advance` says what the Next button does:
 *   'submit'   — the step is a form; save it, and only move on if it saved.
 *   'navigate' — uploads already saved themselves as they happened, so Next
 *                is pure navigation. Forcing a redundant submit on the photo
 *                step would be a lie about what is happening.
 */
export const LISTING_CHAPTERS = [
  {
    id: 'place',
    label: 'The place',
    steps: [
      { id: 'basics', label: 'What it is', advance: 'submit' },
      { id: 'location', label: 'Where it is', advance: 'submit' },
    ],
  },
  {
    id: 'space',
    label: 'The space',
    steps: [
      { id: 'capacity', label: 'Size and capacity', advance: 'submit' },
      { id: 'amenities', label: 'What it has', advance: 'submit' },
    ],
  },
  {
    id: 'terms',
    label: 'Rules and price',
    steps: [
      { id: 'rules', label: 'House rules', advance: 'submit' },
      { id: 'pricing', label: 'Slots and pricing', advance: 'submit' },
      { id: 'terms', label: 'Deposit and cancellation', advance: 'submit' },
    ],
  },
  {
    id: 'photos',
    label: 'Photos',
    steps: [{ id: 'photos', label: 'Photos', advance: 'navigate' }],
  },
  {
    id: 'publish',
    label: 'Proof and publish',
    steps: [
      { id: 'ownership', label: 'Proof it is yours', advance: 'navigate' },
      /**
       * A real ending. Dropping someone back onto the dashboard the instant
       * the last field saves leaves them unsure whether anything happened —
       * the review step is where they see the whole thing and choose to send
       * it. It takes no input, so it never blocks the walkthrough.
       */
      { id: 'review', label: 'Check and send', advance: 'none' },
    ],
  },
];

/**
 * Time-booked venues (entertainment plan, Phase 5). Same chapters and step ids
 * wherever the meaning is shared; `venue` (courts) and `hours` replace size and
 * capacity, and the labels speak about a venue, not a farmhouse.
 */
export const VENUE_CHAPTERS = [
  {
    id: 'place',
    label: 'The venue',
    steps: [
      { id: 'basics', label: 'What it is', advance: 'submit' },
      { id: 'location', label: 'Where it is', advance: 'submit' },
    ],
  },
  {
    id: 'space',
    label: 'Courts and facilities',
    steps: [
      { id: 'venue', label: 'Courts', advance: 'submit' },
      { id: 'amenities', label: 'What it has', advance: 'submit' },
    ],
  },
  {
    id: 'terms',
    label: 'Hours, rules and price',
    steps: [
      { id: 'hours', label: 'Opening hours', advance: 'submit' },
      { id: 'rules', label: 'Venue rules', advance: 'submit' },
      { id: 'pricing', label: 'Hourly prices', advance: 'submit' },
      { id: 'terms', label: 'Deposit and cancellation', advance: 'submit' },
    ],
  },
  {
    id: 'photos',
    label: 'Photos',
    steps: [{ id: 'photos', label: 'Photos', advance: 'navigate' }],
  },
  {
    id: 'publish',
    label: 'Proof and publish',
    steps: [
      { id: 'ownership', label: 'Proof you can list it', advance: 'navigate' },
      { id: 'review', label: 'Check and send', advance: 'none' },
    ],
  },
];

/** The booking model of a listing: 'hour' (venue) or 'slot' (farmhouse, the default). */
export const listingModel = (listing) => (listing?.rentalUnit === 'hour' ? 'hour' : 'slot');

/** Chapters for a booking model. Every helper below takes the same optional `model`. */
export const chaptersFor = (model = 'slot') =>
  model === 'hour' ? VENUE_CHAPTERS : LISTING_CHAPTERS;

const stepsOf = (model) =>
  chaptersFor(model).flatMap((c) =>
    c.steps.map((s) => ({ ...s, chapterId: c.id, chapterLabel: c.label })),
  );

/** Flat step list, in walkthrough order (farmhouse). */
export const LISTING_STEPS = stepsOf('slot');

export const LISTING_STEP_IDS = LISTING_STEPS.map((s) => s.id);

/** Steps that a completion section actually gates. `review` has none. */
export const INPUT_STEP_IDS = LISTING_STEPS.filter((s) => s.advance !== 'none').map((s) => s.id);

const stepIdsOf = (model) => stepsOf(model).map((s) => s.id);
const inputStepIdsOf = (model) =>
  stepsOf(model)
    .filter((s) => s.advance !== 'none')
    .map((s) => s.id);

/**
 * The DOM id of a section wrapper — namespaced, and it has to stay that way.
 *
 * A section and the fields inside it share one document. `<Section id="photos">`
 * rendered `<section id="photos">` directly above `<input id="photos">`, so
 * `<label for="photos">` resolved to the SECTION — and a label pointing at an
 * element that cannot be labelled does nothing at all. The result was an "Add
 * photos" dropzone that looked like a button and was completely dead on click,
 * on the one step of the walkthrough that cannot be completed any other way.
 * `capacity` was silently broken in exactly the same way.
 *
 * Prefixing here fixes the whole class rather than the two instances: no field
 * will ever be named `section-something`.
 *
 * It lives in this module, not in chrome.jsx, because the manage page is a
 * SERVER component and chrome.jsx is `'use client'` — a plain function
 * exported from a client module is a client reference, and calling one on the
 * server throws.
 */
export function sectionAnchorId(id) {
  return `section-${id}`;
}

export function isListingStep(id, model = 'slot') {
  return stepIdsOf(model).includes(id);
}

export function getStep(id, model = 'slot') {
  return stepsOf(model).find((s) => s.id === id) ?? null;
}

export function stepIndex(id, model = 'slot') {
  return stepIdsOf(model).indexOf(id);
}

export function nextStepId(id, model = 'slot') {
  const ids = stepIdsOf(model);
  const i = ids.indexOf(id);
  return i >= 0 && i < ids.length - 1 ? ids[i + 1] : null;
}

export function prevStepId(id, model = 'slot') {
  const ids = stepIdsOf(model);
  const i = ids.indexOf(id);
  return i > 0 ? ids[i - 1] : null;
}

export function stepHref(listingId, stepId) {
  return `/partner/listings/${listingId}/setup/${stepId}`;
}

/**
 * Where to resume. DERIVED from completion, never stored — same reason the
 * completion bar is derived: a stored `current_step` is wrong the moment a
 * photo is deleted or an admin rejects the ownership document.
 */
export function firstIncompleteStepId(completion, model = 'slot') {
  const bySection = new Map(completion.sections.map((s) => [s.id, s]));
  const inputs = inputStepIdsOf(model);
  // A rejected section outranks an unstarted one — send them to the problem.
  const failed = inputs.find((id) => bySection.get(id)?.failed);
  if (failed) return failed;
  const todo = inputs.find((id) => !bySection.get(id)?.done);
  return todo ?? 'review';
}

/**
 * Progress for the walkthrough bar.
 *
 * Deliberately reports two different things:
 *   · `chapter` — where they are, which is what the label shows.
 *   · `doneCount` — how much is actually finished, which drives the fill.
 * Position and completion are not the same number, and conflating them is how
 * a bar ends up full while three sections are still empty.
 */
export function wizardProgress(completion, currentStepId, model = 'slot') {
  const bySection = new Map(completion.sections.map((s) => [s.id, s]));
  const current = getStep(currentStepId, model);
  const allChapters = chaptersFor(model);
  const chapterIndex = allChapters.findIndex((c) => c.id === current?.chapterId);

  const chapters = allChapters.map((c, i) => {
    const gated = c.steps.filter((s) => s.advance !== 'none');
    const done = gated.filter((s) => bySection.get(s.id)?.done).length;
    const failed = gated.some((s) => bySection.get(s.id)?.failed);
    const chapterSteps = c.steps.map((s) => {
      const section = bySection.get(s.id);
      const isReview = s.advance === 'none';
      return {
        id: s.id,
        label: s.label,
        index: stepIndex(s.id, model) + 1,
        done: isReview ? completion.done === completion.total : Boolean(section?.done),
        failed: Boolean(section?.failed),
        isCurrent: s.id === currentStepId,
        isReview,
      };
    });

    return {
      id: c.id,
      label: c.label,
      total: gated.length || 1,
      done: gated.length ? done : 1,
      complete: gated.length ? done === gated.length : true,
      failed,
      isCurrent: i === chapterIndex,
      firstStepId: c.steps[0].id,
      steps: chapterSteps,
    };
  });

  return {
    chapters,
    steps: chapters.flatMap((c) => c.steps.map((s) => ({ ...s, chapterId: c.id }))),
    chapterIndex,
    chapterNumber: chapterIndex + 1,
    chapterTotal: allChapters.length,
    chapterLabel: current?.chapterLabel ?? '',
    stepNumber: stepIndex(currentStepId, model) + 1,
    stepTotal: stepsOf(model).length,
    doneCount: completion.done,
    doneTotal: completion.total,
    percent: completion.total ? Math.round((completion.done / completion.total) * 100) : 0,
    minutesLeft: completion.minutesLeft,
  };
}
