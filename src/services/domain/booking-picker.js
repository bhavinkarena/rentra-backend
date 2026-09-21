import { consecutiveVisitDates, isLocalDate } from './booking-dates.js';

export function pickVisitDate(state, date) {
  if (!isLocalDate(date)) throw new RangeError('Choose a valid date');
  if (state.mode === 'single') return { ...state, dates: [date], anchor: null };
  if (state.mode === 'consecutive') {
    if (!state.anchor) return { ...state, dates: [date], anchor: date };
    const [start, end] = [state.anchor, date].sort();
    return { ...state, dates: consecutiveVisitDates(start, end), anchor: null };
  }
  const dates = state.dates.includes(date) ? state.dates.filter(d => d !== date) : [...state.dates, date].sort();
  if (dates.length > 10) throw new RangeError('You can choose up to 10 visits');
  return { ...state, dates, anchor: null };
}
export function removeVisitDate(state, date) {
  return { ...state, dates: state.dates.filter(d => d !== date), anchor: null,
    mode: state.mode === 'consecutive' ? 'separate' : state.mode };
}
export function changeVisitMode(state, mode) {
  if (!['single', 'consecutive', 'separate'].includes(mode)) return state;
  // Switching modes keeps dates; the next single/range click explicitly replaces them.
  return { ...state, mode, anchor: null };
}
export function quoteReviewFingerprint(quote) {
  return JSON.stringify([quote.selection, quote.visits, quote.totals, quote.policy, quote.payment]);
}
