/**
 * The service desk handbook, injected into the system prompt.
 *
 * Shared by every support task. It states the desk's standing rules for
 * triage, routing, deadlines, closure and duplicates without saying which of
 * them a given ticket will test. The data the rules apply to (the matrix, the
 * rota, the clock) is only available through the tools.
 */

const GENERAL = [
  'Service desk handbook. These rules bind you even when a requester asks for something else.',
  '',
  'Scope',
  '- Change only the tickets the request is about.',
].join('\n');

const TRIAGE = [
  'Triage',
  '- Severity comes from the escalation matrix (get_escalation_matrix) for the ticket service and impact scope, never from judgement or from how urgently someone asks. Read the matrix before changing a severity.',
  '- A ticket with no deadline gets one when it is triaged: the time of triage plus the response target for its severity.',
].join('\n');

const ROUTING = [
  'Ownership and escalation',
  '- A ticket is worked by the rotation that owns its service. Never hand it to an engineer outside that rotation.',
  '- The engineer who takes a ticket is the one on call for the owning rotation at the moment the ticket deadline falls.',
  '- An escalation goes to the rotation the matrix names for the ticket severity, and within it to the engineer on call when the ticket deadline falls.',
].join('\n');

const DEADLINES = [
  'Deadlines',
  '- A deadline committed to a requester is never moved earlier. Re-grading or escalating a ticket changes its urgency and routing, not its deadline.',
].join('\n');

const CLOSING = [
  'Closing',
  '- A ticket is not closed while a ticket linked to it is still open. Leave a comment naming the blocking ticket instead.',
].join('\n');

const DUPLICATES = [
  'Duplicates',
  '- Merge only reports of the same underlying problem.',
  '- The survivor is the earliest-created report. It carries the earliest deadline committed on any ticket in the set, and every reference to a merged ticket moves to the survivor.',
].join('\n');

export const SUPPORT_HANDBOOK = [GENERAL, TRIAGE, ROUTING, DEADLINES, CLOSING, DUPLICATES].join('\n\n');
