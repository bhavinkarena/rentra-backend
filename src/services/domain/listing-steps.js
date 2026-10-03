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
const chapters = (venue = false) => [
  {
    id: 'place',
    label: 'Your place',
    steps: [
      { id: 'type', label: 'Type', advance: 'submit' },
      { id: 'location', label: 'Location', advance: 'submit' },
      { id: 'space', label: venue ? 'Courts' : 'Space', advance: 'submit' },
      { id: 'amenities', label: 'Amenities', advance: 'submit' },
    ],
  },
  {
    id: 'shine',
    label: 'Make it shine',
    steps: [
      { id: 'photos', label: 'Photos', advance: 'navigate' },
      { id: 'story', label: 'Title and description', advance: 'submit' },
    ],
  },
  {
    id: 'publish',
    label: 'Price, rules and submit',
    steps: [
      { id: 'pricing', label: venue ? 'Hourly prices' : 'Pricing', advance: 'submit' },
      { id: 'availability', label: 'Availability', advance: 'submit' },
      { id: 'rules', label: 'Rules and cancellation', advance: 'submit' },
      { id: 'ownership', label: 'Ownership proof', advance: 'navigate' },
      { id: 'preview', label: 'Preview and submit', advance: 'none' },
    ],
  },
];
export const LISTING_CHAPTERS = chapters();
export const VENUE_CHAPTERS = chapters(true);
export const legacyStep = (id) =>
  ({
    basics: 'story',
    capacity: 'space',
    venue: 'space',
    hours: 'availability',
    terms: 'rules',
    review: 'preview',
  })[id] || id;

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
  return todo ?? 'preview';
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
