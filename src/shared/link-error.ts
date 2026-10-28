// Why following a foreign key can fail, shared by the host that checks and the page
// that explains.

export const LINK_ERRORS = ['no-link', 'no-such-row', 'null-value', 'unsupported'] as const;
export type LinkError = (typeof LINK_ERRORS)[number];
