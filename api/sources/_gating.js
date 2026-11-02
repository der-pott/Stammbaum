// Shared gating helpers for sources that only make sense in the digital era.
import { yearOf } from '../http.js';

// Returns true when the person is clearly pre-digital (dead before 1990, or
// born so long ago they couldn't possibly have a digital footprint).
export function isPreDigital(person) {
  const death = yearOf(person.death_date);
  if (death && death < 1990) return true;
  const birth = yearOf(person.birth_date);
  if (birth && birth + 85 < 1990) return true; // likely dead before 1990
  return false;
}
