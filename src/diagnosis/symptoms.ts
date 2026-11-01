import type { SymptomClass } from './types.js';

/**
 * Deterministic keyword mapping from a natural-language issue description to
 * symptom classes the investigator can observe. This is deliberately simple
 * and its output is always reported together with its basis.
 */
const SYMPTOM_PATTERNS: Record<SymptomClass, RegExp> = {
  loading_flicker:
    /\b(flicker\w*|flash\w*|blink\w*|placeholder|skeleton|spinner|loading|loader|jump\w*|layout shift|jank\w*|re-?render\w*)\b/i,
  missing_content:
    /\b(blank|empty|missing|disappear\w*|vanish\w*|not (shown|showing|displayed|rendered|visible|appear\w*|load\w*)|doesn'?t (show|appear|load|render)|nothing (shows|appears))\b/i,
  js_error: /\b(error|exception|crash\w*|undefined|typeerror|referenceerror|uncaught|stack ?trace)\b/i,
  network_failure:
    /\b(fail\w*|404|5\d\d|4\d\d|request|network|api|endpoint|timeout|timed out|fetch|xhr|server)\b/i,
  slow_loading: /\b(slow\w*|takes (too )?long|delay\w*|lag\w*|hang\w*|stuck)\b/i,
};

export function inferSymptoms(...texts: Array<string | undefined>): SymptomClass[] {
  const text = texts.filter(Boolean).join('\n');
  return (Object.keys(SYMPTOM_PATTERNS) as SymptomClass[]).filter((cls) => SYMPTOM_PATTERNS[cls].test(text));
}
