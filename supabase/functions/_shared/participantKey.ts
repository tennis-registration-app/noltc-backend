// Generate participant key for re-registration matching
// Format: sorted "m:<member_id>" and "g:<normalized_guest_name>" joined by "|"
export function generateParticipantKey(participants: Array<{
  type?: string;
  participant_type?: string;  // waitlist uses this field name
  member_id?: string | null;
  guest_name?: string | null;
}>): string {
  const keys: string[] = [];

  for (const p of participants) {
    const pType = p.type || p.participant_type;
    if ((pType === 'member' || pType === 'player') && p.member_id) {
      keys.push(`m:${p.member_id}`);
    } else if ((pType === 'guest' || !p.member_id) && p.guest_name) {
      // Normalize: lowercase, trim, collapse multiple spaces
      const normalized = p.guest_name.toLowerCase().trim().replace(/\s+/g, ' ');
      keys.push(`g:${normalized}`);
    }
  }

  // Sort for consistent ordering
  keys.sort();
  return keys.join('|');
}
