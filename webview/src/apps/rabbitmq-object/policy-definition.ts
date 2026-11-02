// The definition of a RabbitMQ policy as fields (V13.35): the usual keys (message TTL, length
// limits, dead lettering…) get an input each, and everything else stays in a text box of
// JSON, so no key a person knows is lost and none has to be typed as JSON when a field fits.

import type { RABBIT_POLICY_TARGETS } from '../../../../src/shared/protocols/rabbitmq-object';
import type { MessageKey } from '../../l10n/en';

export type PolicyTarget = (typeof RABBIT_POLICY_TARGETS)[number];

export interface PolicyField {
  /** The key in the definition, as the broker names it. */
  readonly key: string;
  /** The text of an input; a number is read as a whole number. */
  readonly kind: 'number' | 'text' | 'select';
  /** The choices of a `select`. */
  readonly options?: readonly string[];
  /** What the key is for: queues, exchanges. */
  readonly for: 'queues' | 'exchanges';
}

/** The keys most policies use, in the order the form shows them. */
export const POLICY_FIELDS: readonly PolicyField[] = [
  { key: 'message-ttl', kind: 'number', for: 'queues' },
  { key: 'expires', kind: 'number', for: 'queues' },
  { key: 'max-length', kind: 'number', for: 'queues' },
  { key: 'max-length-bytes', kind: 'number', for: 'queues' },
  {
    key: 'overflow',
    kind: 'select',
    options: ['drop-head', 'reject-publish', 'reject-publish-dlx'],
    for: 'queues',
  },
  { key: 'dead-letter-exchange', kind: 'text', for: 'queues' },
  { key: 'dead-letter-routing-key', kind: 'text', for: 'queues' },
  { key: 'delivery-limit', kind: 'number', for: 'queues' },
  { key: 'queue-mode', kind: 'select', options: ['default', 'lazy'], for: 'queues' },
  { key: 'alternate-exchange', kind: 'text', for: 'exchanges' },
];

/** The words a text or number input shows while it is empty. */
const HINTS: Readonly<Record<string, MessageKey>> = {
  'message-ttl': 'rabbit.admin.policy.hint.messageTtl',
  expires: 'rabbit.admin.policy.hint.expires',
  'max-length': 'rabbit.admin.policy.hint.maxLength',
  'max-length-bytes': 'rabbit.admin.policy.hint.maxLengthBytes',
  'dead-letter-exchange': 'rabbit.admin.policy.hint.exchange',
  'dead-letter-routing-key': 'rabbit.admin.policy.hint.routingKey',
  'delivery-limit': 'rabbit.admin.policy.hint.deliveryLimit',
  'alternate-exchange': 'rabbit.admin.policy.hint.exchange',
};

/** The message key of the placeholder of a field, when it has one. */
export function hintOf(field: PolicyField): MessageKey | undefined {
  return HINTS[field.key];
}

export type PolicyValues = Record<string, string>;

export interface SplitDefinition {
  /** The text of each field that the definition sets. */
  readonly values: PolicyValues;
  /** The rest of the definition as indented JSON; empty when nothing is left. */
  readonly extra: string;
}

function fieldOf(key: string): PolicyField | undefined {
  return POLICY_FIELDS.find((field) => field.key === key);
}

/**
 * Splits a definition (JSON text) into field values and the rest. A key whose value does not
 * fit its field (a number for a text field, a word for a number) stays in the rest, so
 * nothing is changed by looking at it. Text that is not a JSON object goes whole to the rest.
 */
export function splitDefinition(json: string): SplitDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { values: {}, extra: json.trim() };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { values: {}, extra: json.trim() };
  }
  const values: PolicyValues = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const field = fieldOf(key);
    if (field?.kind === 'number' && typeof value === 'number' && Number.isInteger(value)) {
      values[key] = String(value);
    } else if (
      (field?.kind === 'text' || field?.kind === 'select') &&
      typeof value === 'string' &&
      (field.options === undefined || field.options.includes(value))
    ) {
      values[key] = value;
    } else {
      rest[key] = value;
    }
  }
  return {
    values,
    extra: Object.keys(rest).length === 0 ? '' : JSON.stringify(rest, null, 2),
  };
}

export type JoinResult =
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly reason: 'number'; readonly key: string }
  | { readonly ok: false; readonly reason: 'extra' };

/**
 * Puts the fields and the rest back together as JSON text. A blank field sets nothing; a
 * number field takes whole numbers from 0; the rest must be a JSON object. A key the fields
 * set wins over the same key typed in the rest.
 */
export function joinDefinition(values: PolicyValues, extra: string): JoinResult {
  let definition: Record<string, unknown> = {};
  if (extra.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(extra);
    } catch {
      return { ok: false, reason: 'extra' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: 'extra' };
    }
    definition = { ...(parsed as Record<string, unknown>) };
  }
  for (const field of POLICY_FIELDS) {
    const text = (values[field.key] ?? '').trim();
    if (text === '') {
      continue;
    }
    if (field.kind === 'number') {
      if (!/^\d{1,15}$/u.test(text)) {
        return { ok: false, reason: 'number', key: field.key };
      }
      definition[field.key] = Number(text);
    } else {
      definition[field.key] = text;
    }
  }
  return { ok: true, json: JSON.stringify(definition, null, 2) };
}

/**
 * The fields to show for what a policy applies to, plus those that already hold a value
 * (so changing the target never hides a setting that is in force).
 */
export function visibleFields(applyTo: PolicyTarget, values: PolicyValues): PolicyField[] {
  return POLICY_FIELDS.filter((field) => {
    if ((values[field.key] ?? '').trim() !== '') {
      return true;
    }
    if (applyTo === 'all') {
      return true;
    }
    return applyTo === 'exchanges' ? field.for === 'exchanges' : field.for === 'queues';
  });
}
