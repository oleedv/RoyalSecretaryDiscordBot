// Shared BattleMetrics renderers for AI prompt sections.
// Kept plain (no Discord markdown) since output goes to the LLM, not to chat.

export function formatBMNotes(notes) {
  if (!notes || notes.length === 0) return ''
  const lines = []
  for (const n of notes) {
    const date = n.createdAt ? new Date(n.createdAt).toISOString().slice(0, 10) : '?'
    const text = (n.note || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.push(`- [${date}] ${text}`)
  }
  return lines.join('\n')
}

export function formatBMFlags(flags) {
  if (!flags || flags.length === 0) return ''
  const lines = []
  for (const f of flags) {
    const name = f.name || 'Unnamed flag'
    const desc = (f.description || '').replace(/\s+/g, ' ').trim()
    lines.push(desc ? `- ${name}: ${desc}` : `- ${name}`)
  }
  return lines.join('\n')
}
