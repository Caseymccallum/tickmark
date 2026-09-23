/**
 * What day it is where the practice is.
 *
 * Everything stored here is UTC — timestamps are ISO strings, and a due date is a calendar date with no zone
 * at all. That is deliberate and it does not change. What needed fixing is the arithmetic *about* those
 * timestamps: "is this overdue" was answered by comparing the due date against the UTC date, so a practice in
 * Auckland saw yesterday's date as today and a practice in Hawaii saw tomorrow's, for part of every day. On a
 * tax deadline that is the difference between a request that is late and one that is not.
 *
 * `Intl` does the work rather than arithmetic on an offset, because a stored offset would be wrong twice a
 * year in every country that has daylight saving — and those are exactly the weeks an accountant is busy.
 *
 * An unknown or missing zone falls back to UTC rather than throwing: a practice that typed something odd into
 * a setting should get the old behaviour, not a broken page.
 */
/**
 * Formatters are **built once per zone and kept**, and that is not a micro-optimisation.
 *
 * `new Intl.DateTimeFormat` is expensive: measured on this machine it costs **120 microseconds**, against 1.2 for
 * formatting with one that already exists — a hundred times as much. The first version of this file built a new one
 * on every call, which is invisible on a page that formats one date and enormous on a page that formats one per row:
 * the documents page at a thousand documents was spending most of its hundred milliseconds constructing formatters
 * and throwing them away.
 *
 * The map is bounded in practice because a zone only arrives here from a practice's own setting, which is validated
 * when it is saved (`knownZone`), and from the closed list the settings page offers.
 */
const formatters = new Map();

const UTC = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const formatter = (timeZone) => {
  const zone = timeZone || 'UTC';
  let made = formatters.get(zone);
  if (made) return made;
  try {
    made = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    made = UTC;
  }
  formatters.set(zone, made);
  return made;
};

/** The calendar date (YYYY-MM-DD) in a zone, for an instant — or for now. */
export function dateIn(timeZone, when = new Date()) {
  // en-CA formats as YYYY-MM-DD, which is the same shape the database stores, so no reassembly is needed.
  return formatter(timeZone).format(when);
}

/** Today's date where the practice is. The one comparison the product makes about time. */
export const todayIn = (timeZone, when = new Date()) => dateIn(timeZone, when);

/**
 * The month (YYYY-MM) where the practice is.
 *
 * Used for one thing: the year coming round. A practice asks its clients for the same documents in the same
 * month every year, so "asked in February" is the shape of the relationship — and the comparison has to be on the
 * practice's calendar for the same reason the overdue date is, or a client asked at 11pm on the 31st of January
 * would be filed under February for a practice in Auckland.
 */
export const monthIn = (timeZone, when = new Date()) => dateIn(timeZone, when).slice(0, 7);

/** Whether a zone is one the runtime knows. Checked when a practice sets it, so the fallback above stays a
 * safety net rather than something people quietly live with — and so the formatter cache stays small. */
export function knownZone(timeZone) {
  if (!timeZone) return true;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The zones a browser or a practice is most likely to want, for a form that should not be a text field. */
export const COMMON_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Dublin',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Amsterdam',
  'Africa/Johannesburg',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'Asia/Dubai',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Hong_Kong',
  'Asia/Tokyo',
  'Australia/Perth',
  'Australia/Sydney',
  'Australia/Brisbane',
  'Pacific/Auckland',
];

/**
 * How long ago something happened, in words, for a page a person reads.
 *
 * Minutes, hours, then days, and "just now" below a minute — no weeks and no months, because nothing this product
 * says "ago" about is older than a season: a chase list is about this week. It lives with the time arithmetic rather
 * than beside either page that uses it, because two pages phrasing "3 days ago" differently is exactly the kind of
 * divergence nobody notices until a practitioner does.
 */
export function agoWords(iso, nowIso) {
  const minutes = Math.floor((Date.parse(nowIso) - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
