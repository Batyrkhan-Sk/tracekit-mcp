import type { EvidenceItem } from '../types/evidence.js';

/** One-line, human-readable summary of an evidence item for compact timelines. */
export function summarizeEvidence(item: EvidenceItem): string {
  switch (item.type) {
    case 'console':
      return `console.${item.details.level}: ${truncate(item.details.text, 160)}${item.details.repeatCount > 1 ? ` (×${item.details.repeatCount})` : ''}`;
    case 'page_error':
      return `uncaught ${item.details.name}: ${truncate(item.details.message, 160)}`;
    case 'network_request':
      return `→ ${item.details.method} ${item.url ?? ''} [${item.details.resourceType}]`;
    case 'network_response':
      return `← ${item.details.status} ${item.details.method} ${item.url ?? ''}${item.details.durationMs !== undefined ? ` (${item.details.durationMs}ms)` : ''}${item.details.blockedByInvestigator ? ' [blocked by investigator]' : ''}`;
    case 'network_failure':
      return `✕ ${item.details.method} ${item.url ?? ''}: ${item.details.errorText}${item.details.blockedByInvestigator ? ' [blocked by investigator]' : ''}`;
    case 'navigation':
      return `${item.details.event}${item.url ? ` ${item.url}` : ''}${item.details.note ? ` (${truncate(item.details.note, 120)})` : ''}`;
    case 'dom_visibility':
      return `${item.details.role} ${item.details.visible ? 'visible' : 'hidden'}: ${item.details.selector}${item.details.heuristic ? ' (heuristic)' : ''}`;
    case 'layout_shift':
      return `layout shift ${item.details.value.toFixed(3)} (cumulative ${item.details.cumulative.toFixed(3)})`;
    case 'screenshot':
      return `screenshot ${item.details.file}${item.details.label ? ` "${item.details.label}"` : ''}`;
    case 'action':
      return `step #${item.details.stepIndex} ${item.details.status}: ${item.details.description}${item.details.error ? ` — ${truncate(item.details.error, 160)}` : ''}`;
    case 'security':
      return `blocked (${item.details.reason}) ${item.details.hostname}${item.details.port ? `:${item.details.port}` : ''}`;
    case 'instrumentation':
      return item.details.message;
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
