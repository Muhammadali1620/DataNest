// The algorithms an SSH server is offered (V13.10), written the way OpenSSH's
// `sshd_config` writes them: `+name` adds to the defaults, `-name` removes from them,
// `^name` puts first, and a plain list means exactly these, in this order. Free of
// Node and `ssh2`, so the form and the host check the very same text.

export const SSH_ALGORITHM_KINDS = ['kex', 'serverHostKey', 'cipher', 'hmac', 'compress'] as const;
export type SshAlgorithmKind = (typeof SSH_ALGORITHM_KINDS)[number];

/** One rule per kind; a kind left out keeps ssh2's defaults. */
export type SshAlgorithms = Readonly<Partial<Record<SshAlgorithmKind, string>>>;

/** The longest rule text; there are fewer than 20 names of at most 40 characters. */
export const SSH_ALGORITHM_RULE_MAX = 800;

/**
 * The names `ssh2` 1.17 knows (its `SUPPORTED_*` lists) and the ones it offers unasked
 * (`DEFAULT_*`). A test compares both with the installed package, so a new `ssh2`
 * cannot leave this file behind unnoticed.
 */
export const SSH_ALGORITHMS: Readonly<
  Record<
    SshAlgorithmKind,
    { readonly supported: readonly string[]; readonly defaults: readonly string[] }
  >
> = {
  kex: {
    supported: [
      'curve25519-sha256@libssh.org',
      'curve25519-sha256',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group15-sha512',
      'diffie-hellman-group16-sha512',
      'diffie-hellman-group17-sha512',
      'diffie-hellman-group18-sha512',
      'diffie-hellman-group-exchange-sha1',
      'diffie-hellman-group14-sha1',
      'diffie-hellman-group1-sha1',
    ],
    defaults: [
      'curve25519-sha256@libssh.org',
      'curve25519-sha256',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group15-sha512',
      'diffie-hellman-group16-sha512',
      'diffie-hellman-group17-sha512',
      'diffie-hellman-group18-sha512',
    ],
  },
  serverHostKey: {
    supported: [
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      'ssh-dss',
    ],
    defaults: [
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
    ],
  },
  cipher: {
    supported: [
      'aes128-gcm@openssh.com',
      'aes256-gcm@openssh.com',
      'aes128-ctr',
      'aes192-ctr',
      'chacha20-poly1305@openssh.com',
      'aes256-ctr',
      'aes256-cbc',
      'aes192-cbc',
      'aes128-cbc',
      '3des-cbc',
      'aes128-gcm',
      'aes256-gcm',
    ],
    defaults: [
      'aes128-gcm@openssh.com',
      'aes256-gcm@openssh.com',
      'aes128-ctr',
      'aes192-ctr',
      'chacha20-poly1305@openssh.com',
      'aes256-ctr',
    ],
  },
  hmac: {
    supported: [
      'hmac-sha2-256-etm@openssh.com',
      'hmac-sha2-512-etm@openssh.com',
      'hmac-sha1-etm@openssh.com',
      'hmac-sha2-256',
      'hmac-sha2-512',
      'hmac-sha1',
      'hmac-md5',
      'hmac-sha2-256-96',
      'hmac-sha2-512-96',
      'hmac-ripemd160',
      'hmac-sha1-96',
      'hmac-md5-96',
    ],
    defaults: [
      'hmac-sha2-256-etm@openssh.com',
      'hmac-sha2-512-etm@openssh.com',
      'hmac-sha1-etm@openssh.com',
      'hmac-sha2-256',
      'hmac-sha2-512',
      'hmac-sha1',
    ],
  },
  compress: {
    supported: ['none', 'zlib@openssh.com', 'zlib'],
    defaults: ['none', 'zlib@openssh.com', 'zlib'],
  },
};

/** What a rule asks `ssh2` for: the very list, or a change to its defaults. */
export type AlgorithmChange =
  | { readonly only: readonly string[] }
  | {
      readonly append?: readonly string[];
      readonly prepend?: readonly string[];
      readonly remove?: readonly string[];
    };

export type AlgorithmRuleProblem =
  /** No names after the sign, or nothing between two commas. */
  | { readonly kind: 'empty' }
  /** Names `ssh2` does not know, in the order written. */
  | { readonly kind: 'unknown'; readonly names: readonly string[] };

export type AlgorithmRule =
  | { readonly ok: true; readonly change: AlgorithmChange }
  | { readonly ok: false; readonly problem: AlgorithmRuleProblem };

const SIGNS = new Set(['+', '-', '^']);

/** Reads one rule; text that is blank is `undefined` (the default), never a problem. */
export function parseAlgorithmRule(
  kind: SshAlgorithmKind,
  text: string | undefined,
): AlgorithmRule | undefined {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') {
    return undefined;
  }
  const sign = SIGNS.has(trimmed.charAt(0)) ? trimmed.charAt(0) : undefined;
  const body = sign === undefined ? trimmed : trimmed.slice(1);
  const parts = body.split(',').map((part) => part.trim());
  if (parts.some((part) => part === '')) {
    return { ok: false, problem: { kind: 'empty' } };
  }
  const names = [...new Set(parts)];
  const known = new Set(SSH_ALGORITHMS[kind].supported);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return { ok: false, problem: { kind: 'unknown', names: unknown } };
  }
  const change: AlgorithmChange =
    sign === '+'
      ? { append: names }
      : sign === '-'
        ? { remove: names }
        : sign === '^'
          ? { prepend: names }
          : { only: names };
  return { ok: true, change };
}

/** The kinds whose rule cannot be used, for the form and the store. */
export function algorithmProblems(
  algorithms: SshAlgorithms | undefined,
): { kind: SshAlgorithmKind; problem: AlgorithmRuleProblem }[] {
  const found: { kind: SshAlgorithmKind; problem: AlgorithmRuleProblem }[] = [];
  for (const kind of SSH_ALGORITHM_KINDS) {
    const rule = parseAlgorithmRule(kind, algorithms?.[kind]);
    if (rule !== undefined && !rule.ok) {
      found.push({ kind, problem: rule.problem });
    }
  }
  return found;
}

/**
 * The names a rule lets in that DataNest does not offer on its own: old, weak methods
 * whose use the form says out loud. Removing names never weakens anything.
 */
export function legacyAlgorithms(kind: SshAlgorithmKind, text: string | undefined): string[] {
  const rule = parseAlgorithmRule(kind, text);
  if (!rule?.ok) {
    return [];
  }
  const change = rule.change;
  const added =
    'only' in change ? change.only : [...(change.append ?? []), ...(change.prepend ?? [])];
  const defaults = new Set(SSH_ALGORITHMS[kind].defaults);
  return added.filter((name) => !defaults.has(name));
}

/** The shape of ssh2's `algorithms` option, one entry per kind that has a rule. */
export type Ssh2Algorithms = Record<
  string,
  string[] | { append?: string[]; prepend?: string[]; remove?: string[] }
>;

/** The `algorithms` option of ssh2 for a hop; undefined when every kind is left default. */
export function ssh2Algorithms(algorithms: SshAlgorithms | undefined): Ssh2Algorithms | undefined {
  const result: Ssh2Algorithms = {};
  for (const kind of SSH_ALGORITHM_KINDS) {
    const rule = parseAlgorithmRule(kind, algorithms?.[kind]);
    if (!rule?.ok) {
      continue;
    }
    const change = rule.change;
    if ('only' in change) {
      result[kind] = [...change.only];
    } else {
      result[kind] = {
        ...(change.append === undefined ? {} : { append: [...change.append] }),
        ...(change.prepend === undefined ? {} : { prepend: [...change.prepend] }),
        ...(change.remove === undefined ? {} : { remove: [...change.remove] }),
      };
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

/** A rule as it is stored: trimmed, blanks dropped; undefined when nothing is left. */
export function cleanAlgorithms(algorithms: SshAlgorithms | undefined): SshAlgorithms | undefined {
  const clean: Partial<Record<SshAlgorithmKind, string>> = {};
  for (const kind of SSH_ALGORITHM_KINDS) {
    const text = algorithms?.[kind]?.trim();
    if (text !== undefined && text !== '') {
      clean[kind] = text;
    }
  }
  return Object.keys(clean).length === 0 ? undefined : clean;
}
